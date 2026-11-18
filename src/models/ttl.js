import mongoose from 'mongoose'

/**
 * Makes a collection's expiry rule match `ttlHours`:
 *
 * - a positive number: documents are deleted by MongoDB that many hours after the date in
 *   `field` (a TTL index, created or re-timed as needed);
 * - anything else (0, undefined): no expiry — the TTL index is removed if it exists.
 *
 * This is a function, not part of a schema, because schemas are built once at import time
 * and must not depend on configuration. No other index is ever touched.
 */
export const ensureTtlIndex = async (Model, { field, name, ttlHours }) => {
    const collection = Model.collection
    const seconds = Number.isFinite(ttlHours) && ttlHours > 0 ? Math.round(ttlHours * 3600) : null

    // A collection that does not exist yet has no indexes to list.
    const indexes = await collection.indexes().catch(() => [])
    const existing = indexes.find(index => index.name === name)

    if (seconds === null) {
        if (existing) await collection.dropIndex(name)
        return
    }
    if (!existing) {
        await collection.createIndex({ [field]: 1 }, { name, expireAfterSeconds: seconds })
        return
    }
    if (existing.expireAfterSeconds !== seconds) {
        // An index cannot be re-created with different options; its duration is changed in place.
        await mongoose.connection.db.command({
            collMod: collection.collectionName,
            index: { name, expireAfterSeconds: seconds },
        })
    }
}
