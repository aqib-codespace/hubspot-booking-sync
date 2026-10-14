export function validateTourismHQResponse(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        const received = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
        throw new Error(`Tourism HQ response is empty or not an object (received ${received})`);
    }

    if (!Array.isArray(data.Events)) {
        throw new Error('Tourism HQ response is missing the Events array');
    }

    return data;
}
