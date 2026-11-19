/** Which visual edition this build is: Material 3 ('m3') or Cloudflare dashboard / Kumo ('kumo'). */
export const EDITION: 'm3' | 'kumo' = 'kumo';
export const KUMO = (EDITION as string) === 'kumo';
