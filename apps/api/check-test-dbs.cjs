
const { Client } = require("pg");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing. Load it from the root .env first.");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();

  try {
    const result = await client.query(
      "SELECT datname FROM pg_database"
    );

    const testNames = [
      "wh_lifecycle_probe",
      "wh_lifecycle_probe_rb",
      "wh_lifecycle_probe_big",
    ];

    const existing = result.rows
      .map((row) => row.datname)
      .filter((name) => testNames.includes(name));

    console.log("Existing test databases:", existing);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
