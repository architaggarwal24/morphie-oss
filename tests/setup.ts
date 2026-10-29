import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file gets its own throwaway data directory (database, keys, workspace).
process.env.MORPHIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-test-"));

// Tests share one fake network address ("unknown"), so keep the per-IP request ceiling out of the way;
// the tests that exercise it set their own value.
process.env.MORPHIE_IP_RATE_PER_MIN = "100000";
