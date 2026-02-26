/**
 * MongoAdapter - MongoDB database adapter
 * Uses the official mongodb driver. Schema-less by nature.
 */
const BaseAdapter = require("./BaseAdapter");

let MongoClient;
try {
    const mongodb = require("mongodb");
    MongoClient = mongodb.MongoClient;
} catch (e) {
    console.warn("[MongoAdapter] mongodb package not installed. Install with: npm install mongodb");
}

class MongoAdapter extends BaseAdapter {
    constructor(connectionUrl) {
        super(connectionUrl);
        this.db = null;
        this.mongoClient = null;
    }

    getType() {
        return "mongodb";
    }

    _ensureMongo() {
        if (!MongoClient) {
            throw new Error(
                'MongoDB driver not installed. Run: npm install mongodb'
            );
        }
    }

    /**
     * Extract the database name from the connection URL
     */
    _getDatabaseName() {
        try {
            const url = new URL(this.connectionUrl);
            const dbName = url.pathname.replace("/", "");
            return dbName || "lekana_exports";
        } catch {
            return "lekana_exports";
        }
    }

    async connect() {
        this._ensureMongo();
        this.mongoClient = new MongoClient(this.connectionUrl);
        await this.mongoClient.connect();
        this.db = this.mongoClient.db(this._getDatabaseName());
        console.log(`[MongoAdapter] Connected to database: ${this._getDatabaseName()}`);
    }

    async disconnect() {
        if (this.mongoClient) {
            await this.mongoClient.close();
            console.log("[MongoAdapter] Disconnected");
        }
    }

    async testConnection() {
        this._ensureMongo();
        const startTime = Date.now();
        let client;

        try {
            client = new MongoClient(this.connectionUrl, {
                serverSelectionTimeoutMS: 10000,
            });
            await client.connect();

            const db = client.db(this._getDatabaseName());
            const adminDb = db.admin ? db.admin() : client.db("admin").admin();
            const serverInfo = await adminDb.serverInfo();

            return {
                success: true,
                message: "Connection successful",
                details: {
                    database: this._getDatabaseName(),
                    version: serverInfo.version,
                    connectionTimeMs: Date.now() - startTime,
                    type: "mongodb",
                },
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                details: {
                    code: error.code,
                    connectionTimeMs: Date.now() - startTime,
                    type: "mongodb",
                },
            };
        } finally {
            if (client) {
                try { await client.close(); } catch (e) { /* ignore */ }
            }
        }
    }

    async containerExists(name) {
        const collections = await this.db
            .listCollections({ name })
            .toArray();
        return collections.length > 0;
    }

    async getExistingFields(name) {
        // MongoDB is schema-less, so we sample a document to get field names
        const exists = await this.containerExists(name);
        if (!exists) return new Set();

        const sample = await this.db.collection(name).findOne();
        if (!sample) return new Set();

        return new Set(Object.keys(sample).map((k) => k.toLowerCase()));
    }

    async ensureSchema(name, schema, includeMetadata = true) {
        // MongoDB creates collections automatically on first insert.
        // We just ensure the collection exists for consistency.
        const exists = await this.containerExists(name);

        if (!exists) {
            await this.db.createCollection(name);
            console.log(`[MongoAdapter] Collection "${name}" created`);
        } else {
            console.log(`[MongoAdapter] Collection "${name}" already exists`);
        }

        // Optionally create an index on _execution_id for faster lookups
        if (includeMetadata) {
            try {
                await this.db
                    .collection(name)
                    .createIndex({ _execution_id: 1 }, { background: true });
                console.log(`[MongoAdapter] Index on _execution_id ensured`);
            } catch (e) {
                console.log(`[MongoAdapter] Index creation skipped: ${e.message}`);
            }
        }
    }

    async insertRecords(name, records, onConflict = "skip") {
        let inserted = 0;
        let skipped = 0;

        const collection = this.db.collection(name);

        if (onConflict === "error") {
            // Strict mode: insertMany will throw on any error
            const result = await collection.insertMany(records, { ordered: true });
            inserted = result.insertedCount;
        } else if (onConflict === "update") {
            // Upsert each record individually using _execution_id + _source_filename
            for (const record of records) {
                try {
                    const filter = {};
                    if (record._execution_id) filter._execution_id = record._execution_id;
                    if (record._source_filename) filter._source_filename = record._source_filename;

                    if (Object.keys(filter).length === 0) {
                        // No unique key to upsert on, just insert
                        await collection.insertOne(record);
                        inserted++;
                    } else {
                        const result = await collection.updateOne(
                            filter,
                            { $set: record },
                            { upsert: true }
                        );
                        if (result.upsertedCount > 0 || result.modifiedCount > 0) {
                            inserted++;
                        } else {
                            skipped++;
                        }
                    }
                } catch (error) {
                    skipped++;
                    console.log(`[MongoAdapter] Skipped record: ${error.message}`);
                }
            }
        } else {
            // "skip" mode: insert all, ignore duplicates
            try {
                const result = await collection.insertMany(records, {
                    ordered: false,
                });
                inserted = result.insertedCount;
            } catch (error) {
                // BulkWriteError contains partial results
                if (error.insertedCount !== undefined) {
                    inserted = error.insertedCount;
                    skipped = records.length - inserted;
                } else {
                    throw error;
                }
            }
        }

        console.log(
            `[MongoAdapter] Inserted ${inserted}, skipped ${skipped} into "${name}"`
        );
        return { inserted, skipped };
    }
}

module.exports = MongoAdapter;
