import { Sampling } from "./common";
import { StudioView } from "@/modules/studio/StudioView";
import { useStudioWidgets } from "@/modules/studio/studioStore";
import type { WidgetProps } from "./registry";
import type { ConfigOf, STUDIO_SETTINGS } from "./settings";

/** Dashboard / overlay instance of a Widget Studio widget. */
export default function CustomWidget({ config }: WidgetProps<ConfigOf<typeof STUDIO_SETTINGS>>) {
  const widgets = useStudioWidgets();
  if (!widgets) return <Sampling />;
  const widget = widgets.find((w) => w.id === config["studio.id"]);
  if (!widget) return <div className="unavailable">This custom widget was deleted in Widget Studio.</div>;
  return <StudioView widget={widget} />;
}
