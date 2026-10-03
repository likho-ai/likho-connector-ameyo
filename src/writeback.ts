/**
 * The transcript back into the CRM (MS SQL Server). The statement is a file of the installation
 * (queries/writeback.local.sql), because the table is the company's; it takes two named
 * parameters, @externalId (the call's id) and @transcript (the Hinglish text), and should
 * change the row of that call and nothing else.
 */
import { readFileSync } from 'node:fs';
import sql from 'mssql';

export interface WriteBack {
  write(externalId: string, transcript: string): Promise<number>;
  close(): Promise<void>;
}

export async function openWriteBack(url: string, queryFile: string): Promise<WriteBack> {
  const statement = readFileSync(queryFile, 'utf8');
  const pool = await new sql.ConnectionPool(url).connect();
  return {
    async write(externalId, transcript) {
      const result = await pool
        .request()
        .input('externalId', sql.NVarChar(200), externalId)
        .input('transcript', sql.NVarChar(sql.MAX), transcript)
        .query(statement);
      return result.rowsAffected.reduce((a, b) => a + b, 0);
    },
    close: () => pool.close(),
  };
}
