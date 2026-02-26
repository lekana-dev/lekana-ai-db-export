/**
 * PostgresAdapter - PostgreSQL database adapter
 * Wraps existing pg logic into the universal adapter interface.
 */
const { Client } = require("pg");
const BaseAdapter = require("./BaseAdapter");

class PostgresAdapter extends BaseAdapter {
    constructor(connectionUrl) {
        super(connectionUrl);
    }

    getType() {
        return "postgresql";
    }

    async connect() {
        this.client = new Client({
            connectionString: this.connectionUrl,
            ssl: this.connectionUrl.includes("sslmode=require")
                ? { rejectUnauthorized: false }
                : undefined,
        });
        await this.client.connect();
        console.log("[PostgresAdapter] Connected");
    }

    async disconnect() {
        if (this.client) {
            await this.client.end();
            console.log("[PostgresAdapter] Disconnected");
        }
    }

    async testConnection() {
        const startTime = Date.now();
        let testClient;

        try {
            testClient = new Client({
                connectionString: this.connectionUrl,
                ssl: this.connectionUrl.includes("sslmode=require")
                    ? { rejectUnauthorized: false }
                    : undefined,
                connectionTimeoutMillis: 10000,
            });

            await testClient.connect();
            const result = await testClient.query(
                "SELECT current_database(), current_user, version()"
            );
            const row = result.rows[0];
            const connectionTime = Date.now() - startTime;

            return {
                success: true,
                message: "Connection successful",
                details: {
                    database: row.current_database,
                    user: row.current_user,
                    version: row.version.split(" ").slice(0, 2).join(" "),
                    connectionTimeMs: connectionTime,
                    type: "postgresql",
                },
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                details: {
                    code: error.code,
                    connectionTimeMs: Date.now() - startTime,
                    type: "postgresql",
                },
            };
        } finally {
            if (testClient) {
                try { await testClient.end(); } catch (e) { /* ignore */ }
            }
        }
    }

    async containerExists(name) {
        const result = await this.query(
            `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = $1
      )`,
            [name]
        );
        return result.rows[0].exists;
    }

    async getExistingFields(name) {
        const result = await this.query(
            `SELECT column_name 
       FROM information_schema.columns 
       WHERE table_name = $1`,
            [name]
        );
        return new Set(result.rows.map((row) => row.column_name.toLowerCase()));
    }

    async ensureSchema(name, schema, includeMetadata = true) {
        const exists = await this.containerExists(name);

        if (exists) {
            console.log(`[PostgresAdapter] Table "${name}" already exists`);
            const existingColumns = await this.getExistingFields(name);

            // Add missing data columns
            for (const [columnName, columnType] of Object.entries(schema)) {
                if (columnName.startsWith("_")) continue;
                const safeName = this._sanitize(columnName);
                if (!existingColumns.has(safeName)) {
                    await this.query(
                        `ALTER TABLE "${name}" ADD COLUMN "${safeName}" ${columnType}`
                    );
                    console.log(`[PostgresAdapter] Added column "${safeName}" (${columnType})`);
                }
            }

            // Add missing metadata columns
            await this._ensureMetadataColumns(name, existingColumns, includeMetadata);
            return;
        }

        // Build CREATE TABLE
        const columns = ["id UUID PRIMARY KEY DEFAULT gen_random_uuid()"];

        for (const [columnName, columnType] of Object.entries(schema)) {
            if (columnName.startsWith("_")) continue;
            const safeName = this._sanitize(columnName);
            columns.push(`"${safeName}" ${columnType}`);
        }

        columns.push(`"_source_filename" TEXT`);

        if (includeMetadata) {
            columns.push(`"_execution_id" TEXT`);
            columns.push(`"_workflow_id" TEXT`);
            columns.push(`"_created_at" TIMESTAMP DEFAULT NOW()`);
        }

        columns.push(`"_extra_data" JSONB`);

        const createQuery = `CREATE TABLE "${name}" (\n  ${columns.join(",\n  ")}\n)`;
        await this.query(createQuery);
        console.log(`[PostgresAdapter] Table "${name}" created`);
    }

    async insertRecords(name, records, onConflict = "skip") {
        let inserted = 0;
        let skipped = 0;

        for (const record of records) {
            try {
                const columns = Object.keys(record).map(
                    (k) => `"${this._sanitize(k)}"`
                );
                const placeholders = columns.map((_, i) => `$${i + 1}`);
                const values = Object.values(record).map((v) =>
                    typeof v === "object" && v !== null ? JSON.stringify(v) : v
                );

                let queryText = `INSERT INTO "${name}" (${columns.join(
                    ", "
                )}) VALUES (${placeholders.join(", ")})`;

                if (onConflict === "skip") {
                    queryText += " ON CONFLICT DO NOTHING";
                } else if (onConflict === "update") {
                    const updateCols = columns
                        .filter((c) => c !== '"id"')
                        .map((c) => `${c} = EXCLUDED.${c.replace(/"/g, "")}`)
                        .join(", ");
                    if (updateCols) {
                        queryText += ` ON CONFLICT (id) DO UPDATE SET ${updateCols}`;
                    }
                }

                await this.query(queryText, values);
                inserted++;
            } catch (error) {
                if (onConflict === "skip") {
                    skipped++;
                    console.log(`[PostgresAdapter] Skipped record: ${error.message}`);
                } else {
                    throw error;
                }
            }
        }

        return { inserted, skipped };
    }

    async query(queryText, params = []) {
        if (!this.client) {
            throw new Error("Not connected. Call connect() first.");
        }
        console.log(
            "[PostgresAdapter] QUERY:",
            queryText.replace(/\s+/g, " ").substring(0, 200)
        );
        const result = await this.client.query(queryText, params);
        console.log(`[PostgresAdapter] OK - ${result.rowCount ?? 0} rows affected`);
        return result;
    }

    // ── Private helpers ──

    async _ensureMetadataColumns(name, existingColumns, includeMetadata) {
        const metaCols = [];

        if (!existingColumns.has("_source_filename")) {
            metaCols.push({ name: "_source_filename", type: "TEXT" });
        }
        if (includeMetadata) {
            if (!existingColumns.has("_execution_id"))
                metaCols.push({ name: "_execution_id", type: "TEXT" });
            if (!existingColumns.has("_workflow_id"))
                metaCols.push({ name: "_workflow_id", type: "TEXT" });
            if (!existingColumns.has("_created_at"))
                metaCols.push({ name: "_created_at", type: "TIMESTAMP DEFAULT NOW()" });
        }
        if (!existingColumns.has("_extra_data")) {
            metaCols.push({ name: "_extra_data", type: "JSONB" });
        }

        for (const col of metaCols) {
            await this.query(
                `ALTER TABLE "${name}" ADD COLUMN "${col.name}" ${col.type}`
            );
            console.log(`[PostgresAdapter] Added metadata column "${col.name}"`);
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

module.exports = PostgresAdapter;
