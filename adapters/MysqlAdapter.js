/**
 * MysqlAdapter - MySQL database adapter
 * Uses mysql2 driver with promise interface.
 */
const BaseAdapter = require("./BaseAdapter");

let mysql;
try {
    mysql = require("mysql2/promise");
} catch (e) {
    console.warn("[MysqlAdapter] mysql2 package not installed. Install with: npm install mysql2");
}

class MysqlAdapter extends BaseAdapter {
    constructor(connectionUrl) {
        super(connectionUrl);
    }

    getType() {
        return "mysql";
    }

    _ensureMysql() {
        if (!mysql) {
            throw new Error(
                'MySQL driver not installed. Run: npm install mysql2'
            );
        }
    }

    /**
     * Parse mysql:// URL into connection config
     */
    _parseUrl() {
        const url = new URL(this.connectionUrl);
        return {
            host: url.hostname,
            port: parseInt(url.port) || 3306,
            user: url.username,
            password: decodeURIComponent(url.password),
            database: url.pathname.replace("/", ""),
        };
    }

    async connect() {
        this._ensureMysql();
        const config = this._parseUrl();
        this.client = await mysql.createConnection(config);
        console.log("[MysqlAdapter] Connected");
    }

    async disconnect() {
        if (this.client) {
            await this.client.end();
            console.log("[MysqlAdapter] Disconnected");
        }
    }

    async testConnection() {
        this._ensureMysql();
        const startTime = Date.now();
        let conn;

        try {
            const config = this._parseUrl();
            config.connectTimeout = 10000;
            conn = await mysql.createConnection(config);

            const [rows] = await conn.query(
                "SELECT DATABASE() as db, USER() as user, VERSION() as version"
            );
            const row = rows[0];

            return {
                success: true,
                message: "Connection successful",
                details: {
                    database: row.db,
                    user: row.user,
                    version: row.version,
                    connectionTimeMs: Date.now() - startTime,
                    type: "mysql",
                },
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                details: {
                    code: error.code,
                    connectionTimeMs: Date.now() - startTime,
                    type: "mysql",
                },
            };
        } finally {
            if (conn) {
                try { await conn.end(); } catch (e) { /* ignore */ }
            }
        }
    }

    async containerExists(name) {
        const [rows] = await this.client.query(
            `SELECT COUNT(*) as count FROM information_schema.tables 
       WHERE table_schema = DATABASE() AND table_name = ?`,
            [name]
        );
        return rows[0].count > 0;
    }

    async getExistingFields(name) {
        const [rows] = await this.client.query(
            `SELECT column_name 
       FROM information_schema.columns 
       WHERE table_schema = DATABASE() AND table_name = ?`,
            [name]
        );
        return new Set(rows.map((row) => row.COLUMN_NAME.toLowerCase()));
    }

    async ensureSchema(name, schema, includeMetadata = true) {
        const exists = await this.containerExists(name);

        if (exists) {
            console.log(`[MysqlAdapter] Table "${name}" already exists`);
            const existingColumns = await this.getExistingFields(name);

            for (const [columnName, columnType] of Object.entries(schema)) {
                if (columnName.startsWith("_")) continue;
                const safeName = this._sanitize(columnName);
                if (!existingColumns.has(safeName)) {
                    const mysqlType = this._toMysqlType(columnType);
                    await this.client.query(
                        `ALTER TABLE \`${name}\` ADD COLUMN \`${safeName}\` ${mysqlType}`
                    );
                    console.log(`[MysqlAdapter] Added column "${safeName}" (${mysqlType})`);
                }
            }

            await this._ensureMetadataColumns(name, existingColumns, includeMetadata);
            return;
        }

        // Build CREATE TABLE
        const columns = ["id CHAR(36) PRIMARY KEY DEFAULT (UUID())"];

        for (const [columnName, columnType] of Object.entries(schema)) {
            if (columnName.startsWith("_")) continue;
            const safeName = this._sanitize(columnName);
            const mysqlType = this._toMysqlType(columnType);
            columns.push(`\`${safeName}\` ${mysqlType}`);
        }

        columns.push("`_source_filename` TEXT");

        if (includeMetadata) {
            columns.push("`_execution_id` VARCHAR(255)");
            columns.push("`_workflow_id` VARCHAR(255)");
            columns.push("`_created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
        }

        columns.push("`_extra_data` JSON");

        const createQuery = `CREATE TABLE \`${name}\` (\n  ${columns.join(",\n  ")}\n)`;
        await this.client.query(createQuery);
        console.log(`[MysqlAdapter] Table "${name}" created`);
    }

    async insertRecords(name, records, onConflict = "skip") {
        let inserted = 0;
        let skipped = 0;

        for (const record of records) {
            try {
                const columns = Object.keys(record).map(
                    (k) => `\`${this._sanitize(k)}\``
                );
                const placeholders = columns.map(() => "?");
                const values = Object.values(record).map((v) =>
                    typeof v === "object" && v !== null ? JSON.stringify(v) : v
                );

                let queryText;

                if (onConflict === "skip") {
                    queryText = `INSERT IGNORE INTO \`${name}\` (${columns.join(
                        ", "
                    )}) VALUES (${placeholders.join(", ")})`;
                } else if (onConflict === "update") {
                    const updateCols = columns
                        .filter((c) => c !== "`id`")
                        .map((c) => `${c} = VALUES(${c})`)
                        .join(", ");
                    queryText = `INSERT INTO \`${name}\` (${columns.join(
                        ", "
                    )}) VALUES (${placeholders.join(", ")})`;
                    if (updateCols) {
                        queryText += ` ON DUPLICATE KEY UPDATE ${updateCols}`;
                    }
                } else {
                    queryText = `INSERT INTO \`${name}\` (${columns.join(
                        ", "
                    )}) VALUES (${placeholders.join(", ")})`;
                }

                console.log(
                    "[MysqlAdapter] QUERY:",
                    queryText.substring(0, 200)
                );
                await this.client.query(queryText, values);
                inserted++;
            } catch (error) {
                if (onConflict === "skip") {
                    skipped++;
                    console.log(`[MysqlAdapter] Skipped record: ${error.message}`);
                } else {
                    throw error;
                }
            }
        }

        return { inserted, skipped };
    }

    // ── Private helpers ──

    _toMysqlType(pgType) {
        const typeMap = {
            TEXT: "TEXT",
            INTEGER: "INT",
            DECIMAL: "DECIMAL(18,6)",
            BOOLEAN: "TINYINT(1)",
            JSONB: "JSON",
            JSON: "JSON",
            TIMESTAMP: "TIMESTAMP NULL",
            "TIMESTAMP DEFAULT NOW()": "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        };
        return typeMap[pgType] || "TEXT";
    }

    async _ensureMetadataColumns(name, existingColumns, includeMetadata) {
        const metaCols = [];

        if (!existingColumns.has("_source_filename")) {
            metaCols.push({ name: "_source_filename", type: "TEXT" });
        }
        if (includeMetadata) {
            if (!existingColumns.has("_execution_id"))
                metaCols.push({ name: "_execution_id", type: "VARCHAR(255)" });
            if (!existingColumns.has("_workflow_id"))
                metaCols.push({ name: "_workflow_id", type: "VARCHAR(255)" });
            if (!existingColumns.has("_created_at"))
                metaCols.push({
                    name: "_created_at",
                    type: "TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
                });
        }
        if (!existingColumns.has("_extra_data")) {
            metaCols.push({ name: "_extra_data", type: "JSON" });
        }

        for (const col of metaCols) {
            await this.client.query(
                `ALTER TABLE \`${name}\` ADD COLUMN \`${col.name}\` ${col.type}`
            );
            console.log(`[MysqlAdapter] Added metadata column "${col.name}"`);
        }
    }

    _sanitize(name) {
        const isInternal = name.startsWith("_");
        let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
        if (!isInternal) {
            sanitized = sanitized.replace(/^_+/, "");
        }
        return sanitized;
    }
}

module.exports = MysqlAdapter;
