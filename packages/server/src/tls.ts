import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

/**
 * TLS certificate manager for Community tier (TOFU model)
 * Auto-generates self-signed CA + server certificate on first boot
 * 
 * Per Architecture §7.1.1:
 * - RSA 2048-bit keys (or ECDSA P-256)
 * - 10-year validity for Community
 * - CA cert + server cert + private keys
 * - SHA256 fingerprint for TOFU trust prompt
 */

export interface TlsConfig {
  caPath: string;
  certPath: string;
  keyPath: string;
  serverName: string;
}

export interface TlsCertificates {
  ca: string;
  cert: string;
  key: string;
  caFingerprint: string; // SHA256 fingerprint for TOFU
}

/**
 * Generate self-signed CA certificate
 */
async function generateCA(
  caKeyPath: string,
  caCertPath: string,
  validityDays: number = 3650
): Promise<void> {
  // Generate CA private key (RSA 2048)
  await execCommand('openssl', [
    'genrsa',
    '-out',
    caKeyPath,
    '2048',
  ]);

  // Generate CA certificate
  await execCommand('openssl', [
    'req',
    '-new',
    '-x509',
    '-key',
    caKeyPath,
    '-out',
    caCertPath,
    '-days',
    validityDays.toString(),
    '-subj',
    '/C=US/ST=CA/L=SF/O=MCP Ambassador/OU=Community/CN=MCP Ambassador CA',
  ]);
}

/**
 * Generate server certificate signed by CA
 */
async function generateServerCert(
  caKeyPath: string,
  caCertPath: string,
  serverKeyPath: string,
  serverCertPath: string,
  serverName: string,
  validityDays: number = 3650
): Promise<void> {
  // Generate server private key
  await execCommand('openssl', [
    'genrsa',
    '-out',
    serverKeyPath,
    '2048',
  ]);

  // Generate CSR
  const csrPath = serverCertPath + '.csr';
  await execCommand('openssl', [
    'req',
    '-new',
    '-key',
    serverKeyPath,
    '-out',
    csrPath,
    '-subj',
    `/C=US/ST=CA/L=SF/O=MCP Ambassador/OU=Community/CN=${serverName}`,
  ]);

  // Sign CSR with CA
  await execCommand('openssl', [
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    caCertPath,
    '-CAkey',
    caKeyPath,
    '-CAcreateserial',
    '-out',
    serverCertPath,
    '-days',
    validityDays.toString(),
    '-sha256',
  ]);

  // Cleanup CSR
  await fs.unlink(csrPath);
}

/**
 * Calculate SHA256 fingerprint of certificate (for TOFU)
 */
async function calculateFingerprint(certPath: string): Promise<string> {
  const certPem = await fs.readFile(certPath, 'utf-8');
  
  // Extract DER from PEM
  const derBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s/g, '');
  
  const der = Buffer.from(derBase64, 'base64');
  
  // Calculate SHA256 hash
  const hash = createHash('sha256').update(der).digest('hex');
  
  // Format as SHA256:XX:XX:XX:...
  return 'SHA256:' + hash.match(/.{2}/g)!.join(':').toUpperCase();
}

/**
 * Execute OpenSSL command
 */
function execCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe' });
    
    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} failed with code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to execute ${cmd}: ${err.message}`));
    });
  });
}

/**
 * Initialize TLS certificates
 * - Checks if certificates exist
 * - Generates CA + server cert if missing
 * - Returns certificate paths and CA fingerprint
 */
export async function initializeTls(config: TlsConfig): Promise<TlsCertificates> {
  const { caPath, certPath, keyPath, serverName } = config;
  
  // Ensure directory exists
  const certDir = path.dirname(certPath);
  await fs.mkdir(certDir, { recursive: true, mode: 0o700 });
  
  // Check if certificates already exist
  const filesExist = await Promise.all([
    fs.access(caPath).then(() => true).catch(() => false),
    fs.access(certPath).then(() => true).catch(() => false),
    fs.access(keyPath).then(() => true).catch(() => false),
  ]);
  
  if (!filesExist.every(Boolean)) {
    console.log('[TLS] Generating self-signed CA and server certificate...');
    
    // Generate CA
    const caKeyPath = path.join(certDir, 'ca-key.pem');
    await generateCA(caKeyPath, caPath);
    
    // Generate server certificate
    await generateServerCert(caKeyPath, caPath, keyPath, certPath, serverName);
    
    // Set restrictive permissions
    await Promise.all([
      fs.chmod(caKeyPath, 0o600),
      fs.chmod(keyPath, 0o600),
      fs.chmod(caPath, 0o644),
      fs.chmod(certPath, 0o644),
    ]);
    
    console.log('[TLS] Certificates generated successfully');
  } else {
    console.log('[TLS] Using existing certificates');
  }
  
  // Calculate CA fingerprint for TOFU
  const caFingerprint = await calculateFingerprint(caPath);
  
  // Read certificates
  const [ca, cert, key] = await Promise.all([
    fs.readFile(caPath, 'utf-8'),
    fs.readFile(certPath, 'utf-8'),
    fs.readFile(keyPath, 'utf-8'),
  ]);
  
  return {
    ca,
    cert,
    key,
    caFingerprint,
  };
}
