import { MARVIS } from './marvis-product.js';
export function orderMarvisSlots(pool, slots, sessionId) {
    if (sessionId === undefined || sessionId.length === 0)
        return slots;
    if (!pool.sessionBalanceEnabled())
        return slots;
    return pool.orderAccountsForSession(MARVIS.id, slots, sessionId);
}
//# sourceMappingURL=marvis-slots.js.map