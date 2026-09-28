import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import aiCook2 from "../assets/carousel-2.png";
import aiCook3 from "../assets/carousel-3.png";

const AUTOPLAY_MS = 3500;

const DISHES = [
  {
    name: "Festive Specials",
    tag: "Fresh from the kitchen",
    src: aiCook2,
    alt: "Festive dish fresh from a CookMitra home kitchen",
  },
  {
    name: "Traditional Delights",
    tag: "Authentic taste",
    src: aiCook3,
    alt: "Traditional festive delight prepared at home",
  },
];

const FALLBACK_IMG = aiCook2;

const DishCarousel = () => {
  const [index, setIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const activeDish = DISHES[index];

  useEffect(() => {
    if (DISHES.length <= 1 || isPaused) return undefined;

    const id = setTimeout(() => {
      setIndex((current) => (current + 1) % DISHES.length);
    }, AUTOPLAY_MS);

    return () => clearTimeout(id);
  }, [index, isPaused]);

  const goNext = () => {
    setIndex((current) => (current + 1) % DISHES.length);
  };

  const goPrev = () => {
    setIndex((current) => (current - 1 + DISHES.length) % DISHES.length);
  };

  const goTo = (dishIndex) => {
    setIndex(dishIndex);
  };

  return (
    <section className="dish-carousel" aria-label="Made fresh at home by our cooks">
      <div
        className="dish-stage"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        onFocus={() => setIsPaused(true)}
        onBlur={() => setIsPaused(false)}
      >
        <div className="dish-film">
          <div className="dish-frame active" aria-live="polite">
            <img
              src={activeDish.src}
              alt={activeDish.alt}
              loading="eager"
              decoding="async"
              draggable={false}
              onError={(e) => {
                if (e.currentTarget.src !== FALLBACK_IMG) e.currentTarget.src = FALLBACK_IMG;
              }}
            />
            <span className="dish-card-tag">{activeDish.tag}</span>
          </div>
        </div>

        <button
          type="button"
          className="dish-stage-arrow left"
          onClick={goPrev}
          aria-label="Previous dish"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          className="dish-stage-arrow right"
          onClick={goNext}
          aria-label="Next dish"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="dish-carousel-dots" role="tablist" aria-label="Carousel pages">
        {DISHES.map((dish, i) => (
          <button
            key={dish.name}
            type="button"
            role="tab"
            aria-selected={index === i}
            aria-label={`Go to ${dish.name}`}
            className={`dish-carousel-dot ${index === i ? "active" : ""}`}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
    </section>
  );
};

export default DishCarousel;
