import { Tabs } from "expo-router";
import { TabBarIcon } from "@/components/navigation/TabBarIcon";
import { Palette } from "@/constants/Colors";
import { Typography } from "@/constants/Typography";
import { useAuth } from "@/lib/auth";
import { UserSession } from "@/lib/user-session";

export default function UserLayout() {
  const { user } = useAuth();
  return (
    <UserSession user={user}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: Palette.primary,
          tabBarInactiveTintColor: Palette.onSurfaceVariant,
          tabBarLabelStyle: { fontFamily: Typography.labelMd.fontFamily, fontSize: 11 },
          tabBarStyle: {
            backgroundColor: Palette.background,
            borderTopColor: Palette.outlineVariant,
            height: 80,
            paddingTop: 8,
          },
        }}
      >
        <Tabs.Screen name="index" options={tab("For you", "cafe")} />
        <Tabs.Screen name="saved" options={tab("Saved", "bookmark")} />
        <Tabs.Screen name="account" options={tab("Account", "person")} />
      </Tabs>
    </UserSession>
  );
}

function tab(title, icon) {
  return {
    title,
    tabBarIcon: ({ color, focused }) => (
      <TabBarIcon name={focused ? icon : `${icon}-outline`} color={color} focused={focused} />
    ),
  };
}
