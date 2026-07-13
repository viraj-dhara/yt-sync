// Shared Utilities for YouTube Sync Extension

export function getVideoId(urlStr) {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes('youtube.com')) {
      if (url.pathname.startsWith('/shorts/')) {
        const parts = url.pathname.split('/shorts/');
        if (parts[1]) return parts[1].split('/')[0].split('?')[0];
      }
      if (url.pathname === '/watch') {
        return url.searchParams.get('v');
      }
    }
    return url.href; // Fallback to full URL for generic sites
  } catch (e) {
    return null;
  }
}

export function isUrlDifferent(url1, url2) {
  if (!url1 || !url2) return url1 !== url2;
  if (url1 === url2) return false;
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    
    if (u1.hostname !== u2.hostname || u1.pathname !== u2.pathname) {
      return true;
    }
    
    if (u1.hostname.includes('youtube.com')) {
      if (u1.pathname === '/watch') {
        return u1.searchParams.get('v') !== u2.searchParams.get('v');
      }
      if (u1.pathname.startsWith('/shorts/')) {
        const id1 = u1.pathname.split('/shorts/')[1]?.split('/')[0];
        const id2 = u2.pathname.split('/shorts/')[1]?.split('/')[0];
        return id1 !== id2;
      }
    }
    return false;
  } catch (e) {
    return url1 !== url2;
  }
}

export function isYouTubeUrl(urlStr) {
  if (!urlStr) return false;
  try {
    return new URL(urlStr).hostname.includes('youtube.com');
  } catch (e) {
    return false;
  }
}
