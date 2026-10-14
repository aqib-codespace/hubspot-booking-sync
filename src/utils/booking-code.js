// The booking code is the sole join key between Tourism HQ and HubSpot, so both
// sides must normalise identically. Keeping the rule here stops them drifting apart.
export function normalizeBookingCode(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw).trim().toUpperCase();
}

// HubSpot returns numeric properties as strings, or null when unset.
export function isSameCount(stored, desired) {
    if (stored === null || stored === undefined || stored === '') return false;
    const current = Number(stored);
    return Number.isFinite(current) && current === desired;
}
