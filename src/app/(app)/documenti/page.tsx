import { DocumentUploader } from "@/components/document-uploader";
import { listLibrary } from "@/lib/queries";
import { getUserId } from "@/lib/session";

import { DocumentsTable } from "./documents-table";

export default async function DocumentiPage() {
  const userId = await getUserId();
  if (!userId) return null;

  const library = await listLibrary(userId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Libreria documenti</h1>

      {library.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-700 p-12 text-center">
          <p className="text-4xl">📚</p>
          <h2 className="mt-4 text-lg font-medium">Libreria vuota</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Carica i PDF dei tuoi manuali per iniziare.
          </p>
        </div>
      ) : (
        <DocumentsTable
          documents={library.map((doc) => ({
            id: doc.id,
            title: doc.title,
            description: doc.description,
            docType: doc.docType,
            status: doc.status,
            errorMessage: doc.errorMessage,
            usedBy: doc.usedBy,
          }))}
        />
      )}

      <div className="mt-6">
        <DocumentUploader />
      </div>
    </div>
  );
}
