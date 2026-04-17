export interface OrgmodePluginSettings {
  todoKeywords: string[];
  doneKeywords: string[];
  defaultPriority: string;
  hideStars: boolean;
  dynamicBlockJsFilepath: string;
  bulletStyle: 'dash' | 'unicode' | 'none';
  headingStyle: 'stars' | 'noStars' | 'hashmarks';
  linkifyPlainUrls: boolean;
  shadowIndexEnabled: boolean;
  shadowIndexFolder: string;
}

export const DEFAULT_SETTINGS: OrgmodePluginSettings = {
  todoKeywords: ["TODO", "DOING", "WAITING", "NEXT", "PENDING"],
  doneKeywords: ["DONE", "CANCELLED", "CANCELED", "CANCEL", "REJECTED", "STOP", "STOPPED"],
  defaultPriority: 'B',
  hideStars: false,
  dynamicBlockJsFilepath: "",
  bulletStyle: 'unicode',
  headingStyle: 'stars',
  linkifyPlainUrls: false,
  shadowIndexEnabled: true,
  shadowIndexFolder: "_o",
};

export const BULLET_CHARS: Record<string, string[]> = {
  'dash': ['-', '-', '-', '-', '-', '-'],
  'unicode': ['•', '◦', '▪', '▹', '•', '◦'],
  'none': ['', '', '', '', '', ''],
};
