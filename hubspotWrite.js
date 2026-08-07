const { hubspotClient, getCompanyProperty, anyCompanyHasPropertyValue, getValuesInUse } = require('./hubspotRead');
const { logger, runStats } = require('./logger');

const LEGACY_LABEL_SUFFIX = ' (legacy)';

/*
    HubSpot requires option labels to be unique across a property's ENTIRE
    options array, hidden ones included. Before creating/renaming an option
    to some label, any other option still holding that label (almost always
    a pre-migration legacy option keyed by name instead of associate ID) has
    to be renamed out of the way and hidden first, in the same PATCH, or the
    write fails with NON_UNIQUE_OPTION_LABELS.
*/
function resolveLabelCollision(optionsByValue, label, valueToExclude) {
    for (const [value, option] of optionsByValue) {
        if (value === valueToExclude || option.label !== label) continue;
        if (option.hidden === true && option.label.endsWith(LEGACY_LABEL_SUFFIX)) continue;

        const renamedLabel = option.label.endsWith(LEGACY_LABEL_SUFFIX)
            ? option.label
            : `${option.label}${LEGACY_LABEL_SUFFIX}`;
        optionsByValue.set(value, { ...option, label: renamedLabel, hidden: true });
        logger.warn('Renamed and hid colliding option label to free it up for the correct option', {
            value, oldLabel: option.label, newLabel: renamedLabel
        });
    }
}

/*
    Reconciles a dropdown property's options against this run's active/terminated
    records for one list:
      - active record, associate ID already an option -> update label if name changed, unhide
      - active record, associate ID not yet an option  -> create option (hidden: false)
      - terminated record, associate ID is an option    -> delete if no company anywhere
        still references it, else hide (never both deleted AND still referenced somewhere)
      - terminated record, associate ID not an option    -> ignore

    Sends a single PATCH with the full reconciled options array, since HubSpot's
    property-update endpoint replaces the whole options collection.

    The terminated-record usage check is batched (getValuesInUse, ~100 associate
    IDs per Search API call via the IN operator) rather than one
    anyCompanyHasPropertyValue call per person - a list like team_lead can have
    hundreds of terminated records, which at one call each would be hundreds of
    API round trips every run.

    Note: the usage check reads HubSpot's search index, which is eventually
    consistent - a company updated moments ago by this same run could briefly
    still appear referenced (or not) until the index catches up.

    Pass dryRun: true to compute and log every decision exactly as normal,
    but skip the final PATCH - nothing gets written to HubSpot.

    Returns per-option actions taken, for the run's detailed output.
*/
async function syncDropdownOptions(propertyName, activeRecords, terminatedRecords, dryRun = false) {
    const tag = dryRun ? '[DRY RUN] ' : '';
    const property = await getCompanyProperty(propertyName);
    const optionsByValue = new Map((property.options || []).map(opt => [opt.value, opt]));
    const actions = [];

    for (const record of activeRecords) {
        const existing = optionsByValue.get(record.associateId);
        if (!existing) {
            resolveLabelCollision(optionsByValue, record.fullName, record.associateId);
            optionsByValue.set(record.associateId, {
                label: record.fullName,
                value: record.associateId,
                hidden: false,
                displayOrder: -1
            });
            actions.push({ associateId: record.associateId, fullName: record.fullName, action: 'created' });
            runStats.increment('optionsCreated');
            logger.info(`${tag}Option created`, {
                dropdown: propertyName, associateId: record.associateId, label: record.fullName
            });
            continue;
        }

        const nameChanged = existing.label !== record.fullName;
        const wasHidden = existing.hidden === true;
        if (nameChanged || wasHidden) {
            resolveLabelCollision(optionsByValue, record.fullName, record.associateId);
            optionsByValue.set(record.associateId, { ...existing, label: record.fullName, hidden: false });
            actions.push({ associateId: record.associateId, fullName: record.fullName, action: 'updated' });
            runStats.increment('optionsUpdated');
            logger.info(`${tag}Option updated`, {
                dropdown: propertyName,
                associateId: record.associateId,
                labelBefore: existing.label,
                labelAfter: record.fullName,
                hiddenBefore: wasHidden,
                hiddenAfter: false
            });
        } else {
            actions.push({ associateId: record.associateId, fullName: record.fullName, action: 'unchanged' });
            runStats.increment('optionsUnchanged');
        }
    }

    const terminatedCandidates = terminatedRecords.filter(record => {
        const existing = optionsByValue.get(record.associateId);
        return existing && existing.hidden !== true;
    });

    let valuesInUse = new Set();
    if (terminatedCandidates.length > 0) {
        try {
            valuesInUse = await getValuesInUse(propertyName, terminatedCandidates.map(r => r.associateId));
        } catch (error) {
            logger.error('Failed to batch-check terminated option usage - leaving all as-is this run', {
                propertyName, candidateCount: terminatedCandidates.length, error: error.message
            });
            terminatedCandidates.length = 0;
        }
    }

    for (const record of terminatedCandidates) {
        const existing = optionsByValue.get(record.associateId);
        const stillInUse = valuesInUse.has(record.associateId);

        if (stillInUse) {
            optionsByValue.set(record.associateId, { ...existing, hidden: true });
            actions.push({ associateId: record.associateId, fullName: record.fullName, action: 'hidden' });
            runStats.increment('optionsHidden');
            logger.info(`${tag}Option hidden (terminated, still referenced by a company)`, {
                dropdown: propertyName, associateId: record.associateId, label: record.fullName
            });
        } else {
            optionsByValue.delete(record.associateId);
            actions.push({ associateId: record.associateId, fullName: record.fullName, action: 'deleted' });
            runStats.increment('optionsDeleted');
            logger.info(`${tag}Option deleted (terminated, unreferenced by any company)`, {
                dropdown: propertyName, associateId: record.associateId, label: record.fullName
            });
        }
    }

    if (dryRun) {
        logger.info(`${tag}Would sync HubSpot dropdown options - no write performed`, {
            dropdown: propertyName, actionCount: actions.length
        });
        return actions;
    }

    try {
        await hubspotClient.patch(`/crm/v3/properties/companies/${propertyName}`, {
            options: Array.from(optionsByValue.values())
        });
        logger.info('Synced HubSpot dropdown options', { dropdown: propertyName, actionCount: actions.length });
    } catch (error) {
        logger.error('Failed to update HubSpot dropdown options', { dropdown: propertyName, error: error.message });
        throw error;
    }

    return actions;
}

/*
    Same label-collision problem as resolveLabelCollision, but checks each
    colliding option for real-world usage first (anyCompanyHasPropertyValue,
    unfiltered - not just in-scope companies) and deletes it outright if
    nothing references it anywhere, instead of just hiding+renaming it.
    Only used for manual single-record testing (addSingleDropdownOption) -
    the recurring sync keeps using the safer hide+rename via resolveLabelCollision.
*/
async function resolveLabelCollisionPreferDelete(optionsByValue, propertyName, label, valueToExclude) {
    for (const [value, option] of Array.from(optionsByValue)) {
        if (value === valueToExclude || option.label !== label) continue;
        if (option.hidden === true && option.label.endsWith(LEGACY_LABEL_SUFFIX)) continue;

        const stillInUse = await anyCompanyHasPropertyValue(propertyName, value);
        if (!stillInUse) {
            optionsByValue.delete(value);
            logger.info('Deleted colliding option - not referenced by any company', { propertyName, value, label: option.label });
            continue;
        }

        const renamedLabel = option.label.endsWith(LEGACY_LABEL_SUFFIX)
            ? option.label
            : `${option.label}${LEGACY_LABEL_SUFFIX}`;
        optionsByValue.set(value, { ...option, label: renamedLabel, hidden: true });
        logger.warn('Colliding option still referenced by a company - hiding instead of deleting', {
            propertyName, value, oldLabel: option.label, newLabel: renamedLabel
        });
    }
}

/*
    Adds (or updates, if it already exists) a single option on a dropdown
    property. For manual one-off testing - e.g. adding one real ADO's
    associate ID as an option before testing the company writeback - rather
    than running the full syncDropdownOptions reconciliation.
*/
async function addSingleDropdownOption(propertyName, label, value) {
    const property = await getCompanyProperty(propertyName);
    const optionsByValue = new Map((property.options || []).map(opt => [opt.value, opt]));

    await resolveLabelCollisionPreferDelete(optionsByValue, propertyName, label, value);
    optionsByValue.set(value, { label, value, hidden: false });

    try {
        await hubspotClient.patch(`/crm/v3/properties/companies/${propertyName}`, {
            options: Array.from(optionsByValue.values())
        });
        logger.info('Added single dropdown option', { propertyName, label, value });
    } catch (error) {
        logger.error('Failed to add single dropdown option', { propertyName, label, value, error: error.message });
        throw error;
    }
}

/*
    Deletes a single option from a dropdown property outright - only if no
    company anywhere in the portal (checked without BASE_COMPANY_FILTERS) still
    holds that value. Refuses and returns false rather than deleting a value
    still referenced somewhere, since "hidden" doesn't stop an option from
    being selectable in the record editor (it only affects public forms).
*/
async function deleteSingleDropdownOption(propertyName, value) {
    const stillInUse = await anyCompanyHasPropertyValue(propertyName, value);
    if (stillInUse) {
        logger.warn('Refusing to delete option still referenced by a company', { propertyName, value });
        return false;
    }

    const property = await getCompanyProperty(propertyName);
    const optionsByValue = new Map((property.options || []).map(opt => [opt.value, opt]));
    optionsByValue.delete(value);

    try {
        await hubspotClient.patch(`/crm/v3/properties/companies/${propertyName}`, {
            options: Array.from(optionsByValue.values())
        });
        logger.info('Deleted single dropdown option', { propertyName, value });
        return true;
    } catch (error) {
        logger.error('Failed to delete single dropdown option', { propertyName, value, error: error.message });
        throw error;
    }
}

/*
    Writes the dropdown selection and, if this list has one, the paired raw
    associate ID text field onto one company. associateIdProperty is null for
    "future_*" and ados_in_20_min_drive lists, which have no companion ID
    field (see LIST_DEFINITIONS in config.js) - in that case only the
    dropdown property itself gets written.

    Pass dryRun: true to log the properties that would be set without
    actually PATCHing the company.
*/
async function updateCompanyAdoFields(companyId, associateId, dropdownProperty, associateIdProperty, dryRun = false) {
    const properties = { [dropdownProperty]: associateId };
    if (associateIdProperty) properties[associateIdProperty] = associateId;

    if (dryRun) {
        logger.info('[DRY RUN] Would update company record - no write performed', {
            companyId, associateId, dropdown: dropdownProperty, propertiesSet: properties
        });
        return;
    }

    try {
        await hubspotClient.patch(`/crm/v3/objects/companies/${companyId}`, { properties });
        runStats.increment('companiesUpdated');
        logger.info('Company record updated', {
            companyId,
            associateId,
            dropdown: dropdownProperty,
            propertiesSet: properties
        });
    } catch (error) {
        runStats.increment('errors');
        logger.error('Failed to update company ADO fields', {
            companyId, associateId, dropdownProperty, error: error.message
        });
        throw error;
    }
}

/*
    Replaces one token within a multi-select (semicolon-delimited) property
    value, leaving every other selected token untouched - e.g. changes
    "Bridget Lanigan;Cassandra Favrow;Stephanie King" to
    "3KM8EX843;Cassandra Favrow;Stephanie King" without disturbing the other
    two names. currentValue must be the company's current raw value for this
    property (from the search result that found it), so a plain overwrite
    with just the new value never happens here.
*/
async function replaceMultiSelectToken(companyId, propertyName, currentValue, oldToken, newToken, dryRun = false) {
    const tokens = currentValue.split(';').map(t => t.trim()).filter(Boolean);
    const updatedValue = tokens.map(t => t === oldToken ? newToken : t).join(';');

    if (dryRun) {
        logger.info('[DRY RUN] Would update multi-select company field - no write performed', {
            companyId, dropdown: propertyName, currentValue, proposedValue: updatedValue
        });
        return;
    }

    try {
        await hubspotClient.patch(`/crm/v3/objects/companies/${companyId}`, {
            properties: { [propertyName]: updatedValue }
        });
        runStats.increment('companiesUpdated');
        logger.info('Multi-select company field updated', {
            companyId, dropdown: propertyName, currentValue, updatedValue
        });
    } catch (error) {
        runStats.increment('errors');
        logger.error('Failed to update multi-select company field', {
            companyId, dropdown: propertyName, error: error.message
        });
        throw error;
    }
}

/*
    Sets a single property on a single company. Mainly for manual/ad-hoc
    testing (see test.js) rather than the bulk sync path.
*/
async function updateSingleCompanyProperty(companyId, propertyName, value) {
    try {
        const response = await hubspotClient.patch(`/crm/v3/objects/companies/${companyId}`, {
            properties: { [propertyName]: value }
        });
        logger.info('Updated single company property', { companyId, propertyName, value });
        return response.data;
    } catch (error) {
        logger.error('Failed to update single company property', {
            companyId, propertyName, value, error: error.message
        });
        throw error;
    }
}

module.exports = {
    syncDropdownOptions,
    addSingleDropdownOption,
    deleteSingleDropdownOption,
    updateCompanyAdoFields,
    replaceMultiSelectToken,
    updateSingleCompanyProperty,
    resolveLabelCollision,
    resolveLabelCollisionPreferDelete
};
