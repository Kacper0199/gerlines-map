export function Clock({ text, className }: { text: string; className?: string }) {
  const [hours, minutes] = text.split(":");
  return (
    <span className={className ? `num ${className}` : "num"}>
      {hours}
      <span className="p">:</span>
      {minutes}
    </span>
  );
}
