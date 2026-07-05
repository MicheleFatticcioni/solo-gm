import { listLibrary } from "@/lib/queries";
import { getUserId } from "@/lib/session";

import { NewCampaignForm } from "./new-campaign-form";

export default async function NewCampaignPage() {
  const userId = await getUserId();
  if (!userId) return null;

  const library = await listLibrary(userId);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold">Nuova partita</h1>
      <NewCampaignForm
        documents={library.map((doc) => ({
          id: doc.id,
          title: doc.title,
          description: doc.description,
          docType: doc.docType,
          status: doc.status,
        }))}
      />
    </div>
  );
}
