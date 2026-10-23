import React, { useEffect, useState } from "react";
import aiCook2 from "../assets/carousel-2.png";
import aiCook3 from "../assets/carousel-3.png";

const AUTOPLAY_MS = 3500;

const DISHES = [
  {
    name: "Chakli & Karanji",
    tag: "Diwali faral favourites",
    src: aiCook2,
    alt: "Diwali faral spread fresh from a CookMitra home kitchen",
  },
  {
    name: "Kaju Katli & Sweets",
    tag: "Mithai for the celebration",
    src: aiCook3,
    alt: "Traditional Diwali sweets prepared at home",
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
