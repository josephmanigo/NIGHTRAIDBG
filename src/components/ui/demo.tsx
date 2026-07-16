import { 
  GridBody,
  DraggableContainer,
  GridItem, 
} from "@/components/ui/infinite-drag-scroll";
import { ACHIEVEMENTS } from "@/data/achievements";

const DemoOne = () => {
  return (
    <DraggableContainer variant="masonry">
      <GridBody>
        {ACHIEVEMENTS.map((achievement) => (
          <GridItem
            key={achievement.id}
            className="relative h-72 w-48 md:h-[32rem] md:w-[22rem] overflow-hidden rounded-xl border border-white/5 bg-neutral-900 group"
          >
            <img
              src={achievement.image}
              alt={achievement.alt}
              className="pointer-events-none absolute h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {/* Premium dark overlay on hover to display details */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4 md:p-6 text-left pointer-events-none">
              <span className="text-[#ff3e3e] text-[10px] md:text-xs font-semibold tracking-widest uppercase mb-1">
                {achievement.team}
              </span>
              <h4 className="text-white text-xs md:text-sm font-bold uppercase leading-tight mb-1">
                {achievement.title}
              </h4>
              <span className="text-neutral-400 text-[10px] md:text-xs font-medium mb-2 block">
                {achievement.tournament} ({achievement.dateLabel})
              </span>
              {achievement.description && (
                <p className="text-neutral-300 text-[10px] md:text-xs line-clamp-3 border-t border-white/10 pt-2">
                  {achievement.description}
                </p>
              )}
            </div>
          </GridItem>
        ))}
      </GridBody>
    </DraggableContainer>
  );
};

export { DemoOne };
