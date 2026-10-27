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
    // Re-evaluate when the page content swaps (e.g. wizard steps) without a
    // scroll event, so the FAB never sits on top of a freshly rendered bar.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    const observer = new MutationObserver(schedule);
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      observer.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
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
