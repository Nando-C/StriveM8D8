import mongoose from 'mongoose'

const DEFAULT_OPTIONS = {
    // Without this a connection attempt to an unreachable server takes 30 s to fail.
    serverSelectionTimeoutMS: 5000,
    retryDelayMs: 1000,
    maxRetryDelayMs: 30000,
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export const isDatabaseReady = () => mongoose.connection.readyState === 1

/** A write refused by a unique index: somebody else got there first. */
export const isDuplicateKey = error => error?.code === 11000

// Connects to MongoDB, retrying until it succeeds: Mongoose does not retry a failed
// first connection by itself. Resolves once connected (or at once, after a warning,
// when no URI is given or the URI is malformed) and never rejects, so callers may leave it un-awaited.
export const connectDB = async (uri, options = {}) => {
    if (!uri) {
        console.warn(" ⚠️  MONGO_CONNECTION is not set: messages cannot be saved or loaded")
        return
    }

    const { serverSelectionTimeoutMS, retryDelayMs, maxRetryDelayMs } = { ...DEFAULT_OPTIONS, ...options }

    let delay = retryDelayMs
    for (;;) {
        try {
            await mongoose.connect(uri, { serverSelectionTimeoutMS })
            console.log(" ✅  Connected to MongoDB")
            return
        } catch (error) {
            // A malformed connection string will never start working: say so and stop.
            if (error.name === 'MongoParseError') {
                console.error(" 🚫 MONGO_CONNECTION is not a valid MongoDB connection string: fix it and restart. Messages cannot be saved or loaded.")
                return
            }
            // Only the error name and server code name are logged (e.g. "AuthenticationFailed"):
            // full driver messages can include connection details.
            const reason = error.codeName ? `${error.name}: ${error.codeName}` : error.name
            console.error(` 🚫 MongoDB connection failed (${reason}), retrying in ${delay / 1000}s`)
            await wait(delay)
            delay = Math.min(delay * 2, maxRetryDelayMs)
        }
    }
}
