import mongoose from 'mongoose'

const DEFAULT_OPTIONS = {
    // Without this a connection attempt to an unreachable server takes 30 s to fail.
    serverSelectionTimeoutMS: 5000,
    retryDelayMs: 1000,
    maxRetryDelayMs: 30000,
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export const isDatabaseReady = () => mongoose.connection.readyState === 1

// Connects to MongoDB, retrying until it succeeds: Mongoose does not retry a failed
// first connection by itself. Resolves once connected (or at once, after a warning,
// when no URI is given) and never rejects, so callers may leave it un-awaited.
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
            // Only the error name is logged: driver messages can include connection details.
            console.error(` 🚫 MongoDB connection failed (${error.name}), retrying in ${delay / 1000}s`)
            await wait(delay)
            delay = Math.min(delay * 2, maxRetryDelayMs)
        }
    }
}
