const apiBase = process.env.WORKSPACE_API_BASE || 'http://localhost:4200';

async function main() {
  const response = await fetch(`${apiBase}/api/dev/simulate-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Simulation failed with status ${response.status}`);
  }

  const json = await response.json();
  console.log('Simulated call inserted:');
  console.log(JSON.stringify(json.data, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
