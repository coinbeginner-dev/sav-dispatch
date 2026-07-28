import { SignJWT, jwtVerify } from 'jose';

function secretKey() {
  return new TextEncoder().encode(
    process.env.AUTH_SECRET || 'dev-insecure-secret-change-me'
  );
}

export async function createSession(email) {
  return await new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secretKey());
}

export async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload;
  } catch {
    return null;
  }
}

// Liste des utilisateurs autorisés, définie via la variable d'env APP_USERS
// Format : [{"email":"...","pass":"..."}, ...]
export function getUsers() {
  try {
    return JSON.parse(process.env.APP_USERS || '[]');
  } catch {
    return [];
  }
}
