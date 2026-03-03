export interface OrgmodePluginSettings {
  todoKeywords: string[];
  doneKeywords: string[];
  defaultPriority: string;
  hideStars: boolean;
  dynamicBlockJsFilepath: string
}

export const DEFAULT_SETTINGS: OrgmodePluginSettings = {
  todoKeywords: ["TODO", "DOING", "WAITING", "NEXT", "PENDING"],
  doneKeywords: ["DONE", "CANCELLED", "CANCELED", "CANCEL", "REJECTED", "STOP", "STOPPED"],
  defaultPriority: 'B',
  hideStars: false,
  dynamicBlockJsFilepath: "",
};
