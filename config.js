// Job code (workAssignments[].jobCode.codeValue) patterns per PRIMARY role.
// Each worker gets classified into exactly one primary role. Split into cd/cd3/dor
// (rather than one combined "CD/DOR" role) so cd3 can feed both the broad
// team_lead list and the narrow cd_iii list - see LIST_DEFINITIONS below.
// No 'g' flag - this object is reused across every worker in one pass, and a
// global-flag regex's .test() keeps lastIndex state between calls, causing
// intermittent false negatives.
const JOB_TITLE_PATTERNS = {
    ado: /^ADO$/i,
    rvp: /^REGVP$/i,
    dvp: /^DIVSVP$/i,
    roc: /^REGOPSCO$/i,
    carecoord: /^CARECOOR$/i,
    cd3: /^CD3$/i,
    cd: /^CD$|^CD2$/i,
    dor: /^DORI$|^DORII$|^SRDORII$/i
};

// ADP workAssignments[].assignmentStatus.statusCode.codeValue values
const ADP_STATUS = {
    ACTIVE: 'A',
    LEAVE: 'L',
    TERMINATED: 'T'
};

/*
    One definition per HubSpot dropdown property. eligibleRoles controls who
    can appear as a selectable option in that dropdown (a person can be
    eligible for more than one list - e.g. an ROC shows up in ard, rvp, AND
    regional_ops_coordinator). associateIdField is the paired text property
    this integration writes the same associate ID into; null for "future_*"
    and ados_in_20_min_drive lists, which are dropdown-only (no company-level
    ID field exists for them - see migrateLegacyAdoOptions.js discussion).
    multiSelect: true means the company's stored value is a semicolon-
    delimited list of values (HubSpot checkbox/multi-select field), not one
    atomic value - ados_in_20_min_drive is the only one of these so far.
*/
const LIST_DEFINITIONS = {
    ard: { eligibleRoles: ['ado', 'rvp', 'roc'], associateIdField: 'ado_adp_id' },
    future_ado: { eligibleRoles: ['ado', 'rvp', 'roc'], associateIdField: null },
    ados_in_20_min_drive: { eligibleRoles: ['ado', 'rvp', 'roc'], associateIdField: null, multiSelect: true },

    rvp: { eligibleRoles: ['rvp', 'roc', 'dvp'], associateIdField: 'rvp_adp_id' },
    future_rvp: { eligibleRoles: ['rvp', 'roc', 'dvp'], associateIdField: null },

    dvp: { eligibleRoles: ['dvp'], associateIdField: 'dvp_adp_id' },
    future_dvp: { eligibleRoles: ['dvp'], associateIdField: null },

    team_lead: { eligibleRoles: ['cd', 'cd3', 'dor', 'ado'], associateIdField: 'cd_dor_adp_id' },
    future_team_lead: { eligibleRoles: ['cd', 'cd3', 'dor', 'ado'], associateIdField: null },

    cd_iii: { eligibleRoles: ['cd3'], associateIdField: 'cdiii_adp_id' },

    regional_ops_coordinator: { eligibleRoles: ['roc'], associateIdField: 'roc_adp_id' },

    ops_coordinator: { eligibleRoles: ['carecoord'], associateIdField: 'carecoord_adp_id' },
    future_ops_coordinator: { eligibleRoles: ['carecoord'], associateIdField: null }
};

// Backward-compatible shape for the ADO-only tools built before this
// multi-list expansion (dryRunAdoMigration.js, migrateLegacyAdoOptions.js,
// test.js). New code should read LIST_DEFINITIONS.ard directly instead.
const HUBSPOT_PROPERTIES = {
    ado: { dropdown: 'future_ado', associateId: LIST_DEFINITIONS.ard.associateIdField }
};

module.exports = {
    JOB_TITLE_PATTERNS,
    ADP_STATUS,
    LIST_DEFINITIONS,
    HUBSPOT_PROPERTIES
};
