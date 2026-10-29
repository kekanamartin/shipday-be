// South African provinces, their short codes, and matching of the free-text
// province names found on older records ("GP", "gauteng", "KZN", ...)
const PROVINCES = [
  { name: 'Eastern Cape', code: 'EC' },
  { name: 'Free State', code: 'FS' },
  { name: 'Gauteng', code: 'GP' },
  { name: 'KwaZulu-Natal', code: 'KZN' },
  { name: 'Limpopo', code: 'LP' },
  { name: 'Mpumalanga', code: 'MP' },
  { name: 'North West', code: 'NW' },
  { name: 'Northern Cape', code: 'NC' },
  { name: 'Western Cape', code: 'WC' },
];

const PROVINCE_NAMES = PROVINCES.map((p) => p.name);

const squash = (value) => String(value || '').toLowerCase().replace(/[^a-z]/g, '');

const ALIASES = new Map();
PROVINCES.forEach(({ name, code }) => {
  ALIASES.set(squash(name), name);
  ALIASES.set(squash(code), name);
});
ALIASES.set('kzn', 'KwaZulu-Natal');
ALIASES.set('natal', 'KwaZulu-Natal');
ALIASES.set('gt', 'Gauteng');
ALIASES.set('nwp', 'North West');

// The official province name, or null when it can't be recognised
const matchProvince = (value) => ALIASES.get(squash(value)) || null;
const provinceCode = (name) => PROVINCES.find((p) => p.name === name)?.code || 'XX';

module.exports = { PROVINCES, PROVINCE_NAMES, matchProvince, provinceCode };
