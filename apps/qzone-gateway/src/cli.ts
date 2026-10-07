import { parseGatewayConfig } from './config.js';
import { startGateway } from './server.js';

async function main(): Promise<void> {
  if (process.argv.slice(2).some((argument) => argument !== '--')) throw new Error('Invalid gateway arguments');
  const config = parseGatewayConfig(process.env);
  const service = await startGateway(config);
  const address = service.server.address();
  if (!address || typeof address === 'string') {
    await service.close();
    throw new Error('Gateway did not bind a TCP listener');
  }
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.log(`QZone gateway listening on ${host}:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      void service.close().then(resolve, reject);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

main().catch(() => {
  // Never log raw configuration, request targets, headers, upstream errors or exception details.
  console.error('QZone gateway failed');
  process.exitCode = 1;
});
