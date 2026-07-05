import { notFound } from "next/navigation";

import { parseId } from "@/lib/api";
import { getCampaign } from "@/lib/queries";
import { getUserId } from "@/lib/session";

import { Chat } from "./chat";

export default async function PlayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserId();
  if (!userId) return null;

  const id = parseId((await params).id);
  if (!id) notFound();

  const campaign = await getCampaign(userId, id);
  if (!campaign) notFound();

  return <Chat campaignId={campaign.id} campaignName={campaign.name} />;
}
