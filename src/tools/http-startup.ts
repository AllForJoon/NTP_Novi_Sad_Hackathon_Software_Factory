// Generic HTTP process verification: no product routes or generated code edits.
// runNode supplies the clean child environment; the application gets PORT only.
export const httpStartupCheck = `
const { spawn } = await import('node:child_process');
const { createServer } = await import('node:net');
const { get } = await import('node:http');
const { once } = await import('node:events');
const { setTimeout: sleep } = await import('node:timers/promises');
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = spawn(process.execPath, ['dist/index.js'], { env: { ...process.env, PORT: String(port) }, shell: false, windowsHide: true });
let stdout = '', stderr = '', spawnError;
child.stdout.on('data', data => { stdout = (stdout + data).slice(-8192); });
child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
child.on('error', error => { spawnError = error; });
const probe = () => new Promise(resolve => {
  const request = get({ hostname: '127.0.0.1', port, path: '/', timeout: 250 }, response => { response.resume(); resolve(true); });
  request.on('error', () => resolve(false));
  request.on('timeout', () => { request.destroy(); resolve(false); });
});
try {
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('HTTP entry point exited before listening on PORT; exit=' + child.exitCode + ' stdout=' + stdout + ' stderr=' + stderr);
    if (await probe()) { ready = true; break; }
    await sleep(50);
  }
  if (!ready) throw new Error('HTTP entry point did not respond on its configured PORT within 5 seconds. stdout=' + stdout + ' stderr=' + stderr);
  console.log(JSON.stringify({ httpStartup: 'passed', port }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
}
`;
