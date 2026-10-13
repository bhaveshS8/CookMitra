import React, { useEffect, useState } from "react";
import { resolveFileUrl } from "./CookDocUploads";

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
