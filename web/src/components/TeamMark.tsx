import { slug, teamColour } from "../format";

/** A team's logo when one is on this machine (assets/private/, never in Git), else its colour. */
export function TeamMark({ team, colour, logos }: { team: string; colour: string | null; logos: Record<string, string> }) {
  const logo = logos[slug(team)];
  if (logo) return <img className="team-logo" src={logo} alt="" title={team} />;
  return <span className="team-bar" style={{ background: teamColour(colour) }} title={team} />;
}
