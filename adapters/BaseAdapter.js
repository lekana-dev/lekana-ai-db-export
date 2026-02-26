/**
 * BaseAdapter - Abstract interface for all database adapters
 * Every adapter (Postgres, MySQL, MongoDB) must implement these methods.
 */
class BaseAdapter {
    constructor(connectionUrl) {
        if (new.target === BaseAdapter) {
            throw new Error("Cannot instantiate BaseAdapter directly");
        }
        this.connectionUrl = connectionUrl;
        this.client = null;
    }

    /**
     * Connect to the database
     * @returns {Promise<void>}
     */
    async connect() {
        throw new Error("connect() must be implemented by adapter");
    }

    /**
     * Disconnect from the database
     * @returns {Promise<void>}
     */
    async disconnect() {
        throw new Error("disconnect() must be implemented by adapter");
    }

    /**
     * Test the database connection
     * @returns {Promise<{success: boolean, message: string, details?: object}>}
     */
    async testConnection() {
        throw new Error("testConnection() must be implemented by adapter");
    }

    /**
     * Check if a table/collection exists
     * @param {string} name - Table or collection name
     * @returns {Promise<boolean>}
     */
    async containerExists(name) {
        throw new Error("containerExists() must be implemented by adapter");
    }

    /**
     * Get existing columns/fields in a table/collection
     * @param {string} name - Table or collection name
     * @returns {Promise<Set<string>>}
     */
    async getExistingFields(name) {
        throw new Error("getExistingFields() must be implemented by adapter");
    }

    /**
     * Ensure the table/collection exists with the required schema.
     * For SQL: CREATE TABLE + ALTER TABLE for missing columns.
     * For NoSQL: ensure collection exists (schema is flexible).
     * @param {string} name - Table or collection name
     * @param {Record<string, string>} schema - Field name to type mapping
     * @param {boolean} includeMetadata - Whether to add metadata columns
     * @returns {Promise<void>}
     */
    async ensureSchema(name, schema, includeMetadata) {
        throw new Error("ensureSchema() must be implemented by adapter");
    }

    /**
     * Insert records into the table/collection
     * @param {string} name - Table or collection name
     * @param {any[]} records - Array of record objects
     * @param {string} onConflict - "skip", "update", or "error"
     * @returns {Promise<{inserted: number, skipped: number}>}
     */
    async insertRecords(name, records, onConflict) {
        throw new Error("insertRecords() must be implemented by adapter");
    }

    /**
     * Execute a raw query (SQL adapters only, NoSQL adapters can no-op)
     * @param {string} queryText
     * @param {any[]} params
     * @returns {Promise<any>}
     */
    async query(queryText, params = []) {
        throw new Error("query() not supported by this adapter");
    }

    /**
     * Get the database type identifier
     * @returns {string}
     */
    getType() {
        throw new Error("getType() must be implemented by adapter");
    }
}

module.exports = BaseAdapter;
