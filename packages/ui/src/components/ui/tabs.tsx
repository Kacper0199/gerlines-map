import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "../../lib/cn.ts";

function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("-m-1 flex items-center gap-4 overflow-x-auto p-1", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "type-label focus-ring relative inline-flex min-h-target min-w-target shrink-0 items-center justify-center whitespace-nowrap rounded-md px-2 text-ink-muted transition-colors",
        "hover:text-ink data-active:text-ink",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-ink after:opacity-0 after:transition-opacity data-active:after:opacity-100",
        "aria-disabled:pointer-events-none aria-disabled:opacity-60 disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("focus-ring flex-1 text-sm", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
