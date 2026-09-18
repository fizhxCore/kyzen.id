// ========== ROUTE LOAD REGISTRY (buat admin panel — status boot yang sebenarnya) ==========
let state = {
    total: 0,
    loaded: 0,
    failed: 0,
    failedList: [], // [{ file, error }]
    loadedAt: null,
};

function setRouteLoadResult({ total, loaded, failed, failedList }) {
    state = {
        total,
        loaded,
        failed,
        failedList: failedList || [],
        loadedAt: new Date().toISOString(),
    };
}

function getRouteLoadResult() {
    return state;
}

module.exports = {
    setRouteLoadResult,
    getRouteLoadResult,
};
