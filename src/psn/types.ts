/** Shapes returned by the PSN API. Fields are optional where PSN omits them. */

export interface UserProfile {
  onlineId: string;
  accountId?: string;
  aboutMe?: string;
  avatars?: Array<{ size: string; url: string }>;
  languages?: string[];
  isPlus?: boolean;
  isOfficiallyVerified?: boolean;
  isMe?: boolean;
}

export interface UniversalSearchResult {
  domain: string;
  domainResponse: {
    totalResultCount: number;
    results?: Array<{
      id: string;
      socialMetadata?: {
        accountId: string;
        onlineId: string;
        verifiedUserName?: string;
        avatarUrl?: string;
        isPsPlus?: boolean;
        relationshipState?: string;
      };
    }>;
  };
}

export interface UniversalSearchResponse {
  domainResponses: UniversalSearchResult["domainResponse"][];
}

export interface FriendsResponse {
  friends: string[];
  totalItemCount: number;
  nextOffset?: number;
  previousOffset?: number;
}

export interface BasicPresence {
  accountId?: string;
  availability?: string;
  lastAvailableDate?: string;
  primaryPlatformInfo?: {
    onlineStatus?: string;
    platform?: string;
    lastOnlineDate?: string;
  };
  gameTitleInfoList?: Array<{
    npTitleId: string;
    titleName: string;
    format?: string;
    launchPlatform?: string;
    conceptIconUrl?: string;
  }>;
}

export interface TrophySummary {
  accountId: string;
  trophyLevel: number;
  progress: number;
  tier: number;
  earnedTrophies: TrophyCounts;
}

export interface TrophyCounts {
  bronze: number;
  silver: number;
  gold: number;
  platinum: number;
}

export interface TrophyTitle {
  npServiceName: "trophy" | "trophy2";
  npCommunicationId: string;
  trophyTitleName: string;
  trophyTitleDetail?: string;
  trophyTitleIconUrl?: string;
  trophyTitlePlatform: string;
  hasTrophyGroups: boolean;
  definedTrophies: TrophyCounts;
  progress: number;
  earnedTrophies: TrophyCounts;
  hiddenFlag?: boolean;
  lastUpdatedDateTime: string;
}

export interface TrophyTitlesResponse {
  trophyTitles: TrophyTitle[];
  totalItemCount: number;
  nextOffset?: number;
}

export interface Trophy {
  trophyId: number;
  trophyHidden: boolean;
  trophyType: "bronze" | "silver" | "gold" | "platinum";
  trophyName?: string;
  trophyDetail?: string;
  trophyIconUrl?: string;
  trophyGroupId?: string;
  // Fields present only on "earned trophies for a user" responses:
  earned?: boolean;
  earnedDateTime?: string;
  trophyEarnedRate?: string;
  trophyRare?: number;
  progress?: string;
  progressRate?: number;
}

export interface TrophiesResponse {
  trophySetVersion: string;
  hasTrophyGroups: boolean;
  trophies: Trophy[];
  totalItemCount: number;
  nextOffset?: number;
}

export interface PlayedGame {
  titleId: string;
  name: string;
  localizedName?: string;
  imageUrl?: string;
  category: string;
  playCount?: number;
  firstPlayedDateTime?: string;
  lastPlayedDateTime?: string;
  playDuration?: string;
}

export interface PlayedGamesResponse {
  titles: PlayedGame[];
  totalItemCount: number;
  nextOffset?: number;
}
