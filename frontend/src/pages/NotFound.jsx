import { Link } from "react-router-dom";
import { ArrowLeft, ChefHat, House, PartyPopper } from "lucide-react";

const NotFound = () => (
  <section className="not-found-page" aria-labelledby="not-found-title">
    <div className="not-found-card">
      <div className="not-found-art" aria-hidden="true">
        <span className="not-found-orbit not-found-orbit-outer" />
        <span className="not-found-orbit not-found-orbit-inner" />
        <span className="not-found-number">404</span>
        <span className="not-found-chef">
          <ChefHat size={46} strokeWidth={1.7} />
        </span>
        <span className="not-found-spark not-found-spark-one">✦</span>
        <span className="not-found-spark not-found-spark-two">✦</span>
      </div>

      <div className="not-found-copy">
        <span className="not-found-eyebrow">
          <PartyPopper size={15} />
          A little detour
        </span>
        <h1 id="not-found-title">
          This page isn’t <span>on the menu.</span>
        </h1>
        <p>
          The link may be old, or the page may have moved. Let’s get you back to
          something delicious.
        </p>
        <div className="not-found-actions">
          <Link to="/" className="btn btn-primary">
            <House size={17} />
            Back to home
          </Link>
          <Link to="/events" className="btn btn-outline">
            <ArrowLeft size={17} />
            Explore events
          </Link>
        </div>
        <span className="not-found-note">CookMitra · Your cook. Your occasion. Your kitchen.</span>
      </div>
    </div>
  </section>
);

export default NotFound;
