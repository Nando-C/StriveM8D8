import { MongoMemoryServer } from 'mongodb-memory-server'

export default async function setup(project) {
    // (A minute to start, not the default ten seconds: a busy CI machine can need more.)
    const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
    project.provide('mongoUri', mongo.getUri())

    return async () => {
        await mongo.stop()
    }
}
