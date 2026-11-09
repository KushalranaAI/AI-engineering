import { FlaskConical } from "lucide-react";
import { SIMS } from "./sims-list";

/** Renders one simulator by id inside a lesson: a title row, then the sim itself. */
export function SimEmbed({ id }: { id: string }) {
  const sim = SIMS.find((s) => s.id === id);
  if (!sim) return <p className="sim-note">Unknown simulator: {id}</p>;
  const C = sim.Component;
  return (
    <div className="sim-embed">
      <div className="sim-embed-head">
        <FlaskConical size={16} aria-hidden />
        <div>
          <h3>{sim.title}</h3>
          <p>{sim.blurb}</p>
        </div>
      </div>
      <C />
    </div>
  );
}
