import React, { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

const STICKY_BAR_SELECTOR = ".od-stickybar, .bk-stickybar, .bd-actionbar";

const stickyBarInView = () => {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  return Array.from(document.querySelectorAll(STICKY_BAR_SELECTOR)).some((el) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
};

const BackToTop = () => {
  const [show, setShow] = useState(false);
  const [barVisible, setBarVisible] = useState(false);

  useEffect(() => {
    const update = () => {
      setShow(window.scrollY > 600);
      setBarVisible(stickyBarInView());
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const visible = show && !barVisible;

  return (
    <button
      className={`to-top-fab ${visible ? "show" : ""}`}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
    >
      <ArrowUp size={20} />
    </button>
  );
};

export default BackToTop;
