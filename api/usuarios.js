// Vercel Serverless Function — /api/usuarios
//   POST   → crea usuario en Supabase Auth + su registro en "perfiles"
//   PATCH  → cambia correo y/o contraseña de un usuario en Auth
//   DELETE → elimina usuario de Auth y su perfil
//
// La service_role key vive SOLO aquí, como variable de entorno en Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (obligatoria)
//   SUPABASE_URL               (opcional, por defecto el proyecto de AS Industrial)
// Nunca debe ponerse en index.html.

const SUPA_URL = process.env.SUPABASE_URL || 'https://aidawdimcqxuqgcurrfb.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ROLES = ['admin', 'tecnico', 'supervisor', 'ayudante', 'cliente'];

const svc = (extra = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

async function readJson(r) {
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch { return { raw: t }; }
}
const errMsg = (j, def) => j?.msg || j?.message || j?.error_description || j?.error || def;

// Solo un usuario con sesión válida y rol "admin" en perfiles puede usar esta API
async function requireAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { status: 401, error: 'Sin sesión' };

  const u = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!u.ok) return { status: 401, error: 'Sesión inválida o expirada, vuelve a iniciar sesión' };
  const user = await u.json();

  const p = await fetch(`${SUPA_URL}/rest/v1/perfiles?id=eq.${user.id}&select=rol`, { headers: svc() });
  const rows = await readJson(p);
  if (!Array.isArray(rows) || rows[0]?.rol !== 'admin') {
    return { status: 403, error: 'Solo un administrador puede gestionar usuarios' };
  }
  return { user };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en Vercel' });

  const gate = await requireAdmin(req);
  if (gate.error) return res.status(gate.status).json({ error: gate.error });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }

  try {
    // ── CREAR ──
    if (req.method === 'POST') {
      const nombre = String(body.nombre || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const rol = String(body.rol || '');
      if (!nombre || !email) return res.status(400).json({ error: 'Nombre y correo son obligatorios' });
      if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
      if (!ROLES.includes(rol)) return res.status(400).json({ error: 'Rol inválido' });

      const cr = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: svc(),
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { nombre } }),
      });
      const created = await readJson(cr);
      if (!cr.ok) return res.status(cr.status).json({ error: errMsg(created, 'No se pudo crear el usuario') });
      const id = created.id || created.user?.id;

      const perfil = {
        id, nombre, rol, email,
        cliente_id: body.cliente_id || null,
        planta_id: rol === 'cliente' ? (body.planta_id || null) : null,
        numero_empleado: body.numero_empleado || null,
      };
      // upsert por si existe un trigger que ya crea el perfil al registrarse
      const pr = await fetch(`${SUPA_URL}/rest/v1/perfiles?on_conflict=id`, {
        method: 'POST',
        headers: svc({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(perfil),
      });
      if (!pr.ok) {
        const perr = await readJson(pr);
        // revertir para no dejar un usuario de Auth sin perfil
        await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: svc() });
        return res.status(400).json({ error: 'Error al crear perfil: ' + errMsg(perr, 'desconocido') });
      }
      return res.status(201).json({ ok: true, id });
    }

    // ── CAMBIAR CORREO / CONTRASEÑA ──
    if (req.method === 'PATCH') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'Falta el id del usuario' });
      const changes = {};
      if (body.email) { changes.email = String(body.email).trim().toLowerCase(); changes.email_confirm = true; }
      if (body.password) {
        if (String(body.password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
        changes.password = String(body.password);
      }
      if (!Object.keys(changes).length) return res.status(200).json({ ok: true });

      const ur = await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, {
        method: 'PUT', headers: svc(), body: JSON.stringify(changes),
      });
      const uj = await readJson(ur);
      if (!ur.ok) return res.status(ur.status).json({ error: errMsg(uj, 'No se pudo actualizar el usuario') });
      return res.status(200).json({ ok: true });
    }

    // ── ELIMINAR ──
    if (req.method === 'DELETE') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'Falta el id del usuario' });
      if (id === gate.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });

      await fetch(`${SUPA_URL}/rest/v1/perfiles?id=eq.${id}`, { method: 'DELETE', headers: svc() });
      const dr = await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: svc() });
      if (!dr.ok && dr.status !== 404) {
        const dj = await readJson(dr);
        return res.status(dr.status).json({ error: errMsg(dj, 'No se pudo eliminar de Auth') });
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error interno' });
  }
};
