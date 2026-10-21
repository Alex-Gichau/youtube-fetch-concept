function normalizeSearchQuery(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function isYouTubeUrl(value = '') {
  const raw = normalizeSearchQuery(value);
  if (!raw) return false;

  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return /(^|\.)youtube\.com$/.test(url.hostname) || /(^|\.)youtu\.be$/.test(url.hostname);
  } catch {
    return false;
  }
}

function isSearchInput(value = '') {
  const query = normalizeSearchQuery(value);
  if (!query) return false;
  if (isYouTubeUrl(query)) return false;
  if (/^[A-Za-z0-9_-]{13,}$/.test(query)) return false;
  return true;
}

module.exports = {
  normalizeSearchQuery,
  isYouTubeUrl,
  isSearchInput,
};
