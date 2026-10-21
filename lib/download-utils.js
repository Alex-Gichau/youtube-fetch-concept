function sanitizeFileName(input = '') {
  const cleaned = String(input)
    .replace(/[\\/?%*:|"<>\r\n]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '');

  return cleaned || 'youtube-download';
}

function buildDownloadRequest({ videoId, title, format = 'video', mode = 'single', playlistId } = {}) {
  const safeFormat = format === 'audio' ? 'audio' : 'video';
  const safeMode = mode === 'batch' ? 'batch' : 'single';
  const cleanTitle = (title || videoId || 'youtube-download').trim() || 'youtube-download';
  const safeTitle = cleanTitle.replace(/[\\/?%*:|"<>]+/g, '').trim() || 'youtube-download';
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
