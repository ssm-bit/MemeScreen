// ============================================================
// MemeScreen exec — push a message to every phone of a user through the Back4App pushToUser cloud function.
// The master key lets the service push on behalf of a user; it never leaves this process.
// ============================================================
const B4A = process.env.BACK4APP_URL || 'https://parseapi.back4app.com';
export let fetchImpl = (...a) => fetch(...a);
export function setFetch(f){ fetchImpl = f; }

export async function push(userId, title, message, data = {}){
  const master = process.env.BACK4APP_MASTER_KEY;
  if (!master) return { skipped: 'no BACK4APP_MASTER_KEY' };
  try {
    const r = await fetchImpl(B4A + '/functions/pushToUser', { method: 'POST', headers: { 'X-Parse-Application-Id': process.env.BACK4APP_APP_ID || '', 'X-Parse-Master-Key': master, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, title, message, data }) });
    const j = await r.json().catch(() => ({}));
    return j.result || j;
  } catch (e) { return { error: e.message }; }
}
