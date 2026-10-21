function sanitizeFileName(input = '') {
  const normalized = String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '')
    .replace(/([a-zA-Z0-9])['"]([a-zA-Z0-9])/g, '$1_$2')
    .replace(/['"]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'youtube-download';
}

function buildDownloadRequest({ videoId, title, format = 'video', mode = 'single', playlistId } = {}) {
  const safeFormat = format === 'audio' ? 'audio' : 'video';
  const safeMode = mode === 'batch' ? 'batch' : 'single';
  const cleanTitle = (title || videoId || 'youtube-download').trim() || 'youtube-download';
  const safeTitle = sanitizeFileName(cleanTitle) || 'youtube-download';
  const extension = safeFormat === 'audio' ? 'mp3' : 'mp4';

  return {
    videoId,
    playlistId,
    title: cleanTitle,
    format: safeFormat,
    mode: safeMode,
    fileName: `${safeTitle}.${extension}`,
    extension,
  };
}

module.exports = {
  sanitizeFileName,
  buildDownloadRequest,
};
