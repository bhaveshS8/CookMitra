import React, { useEffect, useState } from "react";
import { resolveFileUrl } from "./CookDocUploads";

// Cook profile photo with automatic fallback. A stored photoUrl can go stale
// (e.g. server uploads wiped by a redeploy without a persistent volume), so
// both a missing URL and a broken URL render `fallback` (default: the cook's
// initial) instead of a broken-image icon.
//
// Props: photoUrl, name (alt text + default initial), fallback (node shown
// when there is no usable photo). Any extra props spread onto the <img>.
const CookAvatar = ({ photoUrl, name, fallback, alt, ...imgProps }) => {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [photoUrl]);
  if (!photoUrl || broken) {
    return <>{fallback ?? name?.[0]?.toUpperCase() ?? "C"}</>;
  }
  return (
    <img
      src={resolveFileUrl(photoUrl)}
      alt={alt ?? name ?? "Cook"}
      onError={() => setBroken(true)}
      {...imgProps}
    />
  );
};

export default CookAvatar;
