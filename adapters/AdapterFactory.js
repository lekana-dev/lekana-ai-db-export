/**
 * AdapterFactory - Detects the database type from the connection URL
 * and returns the appropriate adapter instance.
 */
const PostgresAdapter = require("./PostgresAdapter");
const MysqlAdapter = require("./MysqlAdapter");
const MongoAdapter = require("./MongoAdapter");

/**
 * Detect database type from URL and return the correct adapter
 * @param {string} connectionUrl - Database connection string
 * @returns {import('./BaseAdapter')} Adapter instance
 */
function getAdapter(connectionUrl) {
    if (!connectionUrl) {
        throw new Error("connectionUrl is required");
    }

    const url = connectionUrl.toLowerCase().trim();

    // PostgreSQL
    if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
        console.log("[AdapterFactory] Detected PostgreSQL");
        return new PostgresAdapter(connectionUrl);
    }

    // MySQL
    if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
        console.log("[AdapterFactory] Detected MySQL");
        return new MysqlAdapter(connectionUrl);
    }

    // MongoDB
    if (url.startsWith("mongodb://") || url.startsWith("mongodb+srv://")) {
        console.log("[AdapterFactory] Detected MongoDB");
        return new MongoAdapter(connectionUrl);
    }

    throw new Error(
        `Unsupported database URL format: "${connectionUrl.substring(0, 20)}...". ` +
        `Supported protocols: postgres://, mysql://, mongodb://`
    );
}

/**
 * Get a list of supported database types
 * @returns {string[]}
 */
function getSupportedTypes() {
    return ["postgresql", "mysql", "mongodb"];
}

module.exports = {
    getAdapter,
    getSupportedTypes,
};
