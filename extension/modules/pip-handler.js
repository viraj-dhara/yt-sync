// Picture-in-Picture & Overlay Location Handler

export function findVideoAtPoint(x, y) {
  // 1. Try elementsFromPoint to penetrate transparent overlays (e.g., Google Meet controls, overlay divs)
  if (document.elementsFromPoint) {
    const elements = document.elementsFromPoint(x, y);
    for (const el of elements) {
      if (el.tagName && el.tagName.toLowerCase() === 'video') {
        return el;
      }
      const childVideo = el.querySelector && el.querySelector('video');
      if (childVideo) {
        return childVideo;
      }
    }
  }

  // 2. Fallback: find all video elements on page and select the one containing or closest to (x, y)
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  let closestVideo = null;
  let minDistance = Infinity;

  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return video; // Directly inside rect
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dist = Math.hypot(x - centerX, y - centerY);
    if (dist < minDistance) {
      minDistance = dist;
      closestVideo = video;
    }
  }

  return closestVideo || videos[0];
}

export async function requestPictureInPictureForVideo(video) {
  if (!video) return false;
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      return true;
    } else {
      await video.requestPictureInPicture();
      return true;
    }
  } catch (err) {
    console.error('[YouTube Sync] PiP Error:', err);
    return false;
  }
}
