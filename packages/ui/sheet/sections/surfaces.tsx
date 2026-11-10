import { EllipsisIcon, Share2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  BottomSheet,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../src/index.ts";
import { Grid, Section, Specimen } from "../layout.tsx";
import { SAMPLE, type SheetStrings } from "../strings.ts";
import { CloseButton, SheetBody, TrainCardSpecimen } from "./train-card.tsx";

function Overlays({ strings }: { strings: SheetStrings }) {
  return (
    <Specimen label="Tooltip, popover, menu and dialog">
      <Tooltip>
        <TooltipTrigger render={<Button variant="secondary" />}>
          {strings.tooltipTrigger}
        </TooltipTrigger>
        <TooltipContent>{strings.tooltip}</TooltipContent>
      </Tooltip>
      <Popover>
        <PopoverTrigger render={<Button variant="secondary" />}>
          {strings.popoverTrigger}
        </PopoverTrigger>
        <PopoverContent>
          <PopoverHeader>
            <PopoverTitle>{strings.popoverTrigger}</PopoverTitle>
            <PopoverDescription>{strings.positionEstimated}</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger render={<IconButton label={strings.menuLabel} variant="secondary" />}>
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{strings.menuLabel}</DropdownMenuLabel>
            <DropdownMenuItem>{strings.follow}</DropdownMenuItem>
            <DropdownMenuItem>{strings.route}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>{strings.share}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog>
        <DialogTrigger render={<Button variant="secondary" />}>
          <Share2 aria-hidden="true" />
          {strings.share}
        </DialogTrigger>
        <DialogContent closeLabel={strings.close}>
          <DialogHeader>
            <DialogTitle>{strings.dialogTitle}</DialogTitle>
            <DialogDescription>{strings.dialogBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="quiet" />}>{strings.cancel}</DialogClose>
            <DialogClose render={<Button variant="solid" />}>{strings.confirm}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Specimen>
  );
}

function Loading({ strings }: { strings: SheetStrings }) {
  return (
    <Specimen label="Loading, long name and missing data" className="items-start">
      <Card
        className="w-full max-w-[300px]"
        role="group"
        aria-busy="true"
        aria-label={strings.trainTitle}
      >
        <CardHeader>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-40" />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
      <Card className="w-full max-w-[300px]">
        <CardHeader>
          <CardTitle>{SAMPLE.longStopName}</CardTitle>
          <CardDescription>{SAMPLE.longStopSource}</CardDescription>
        </CardHeader>
        <CardContent className="type-body text-ink-muted">{strings.untracked}</CardContent>
      </Card>
    </Specimen>
  );
}

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[620px] w-[390px] max-w-full shrink-0 overflow-hidden rounded-xl border bg-map-land">
      {children}
    </div>
  );
}

function SheetSpecimen({
  strings,
  number,
  expanded,
}: {
  strings: SheetStrings;
  number: number;
  expanded: boolean;
}) {
  return (
    <PhoneFrame>
      <BottomSheet
        position="absolute"
        defaultExpanded={expanded}
        label={`${strings.trainTitle} ${number}`}
        expandLabel={strings.expandSheet}
        collapseLabel={strings.collapseSheet}
        trailing={<CloseButton strings={strings} />}
        {...(expanded ? { expandedHeight: "540px" } : {})}
      >
        <SheetBody strings={strings} />
      </BottomSheet>
    </PhoneFrame>
  );
}

export function Surfaces({ strings }: { strings: SheetStrings }) {
  return (
    <Section
      id="surfaces"
      title="Cards, sheet and overlays"
      note="The train card is a composition of the atoms for this sheet only. WP-4.3 builds the real one, with the full stop list. The bottom sheet has a peek state of 304 px and an expanded state."
    >
      <Grid className="items-start">
        <Specimen label="Floating card, train head">
          <Card className="w-full max-w-[380px] py-3">
            <TrainCardSpecimen strings={strings} />
          </Card>
        </Specimen>
        <Specimen label="Bottom sheet, peek">
          <SheetSpecimen strings={strings} number={1} expanded={false} />
        </Specimen>
        <Specimen label="Bottom sheet, expanded">
          <SheetSpecimen strings={strings} number={2} expanded />
        </Specimen>
      </Grid>
      <Overlays strings={strings} />
      <Loading strings={strings} />
    </Section>
  );
}
