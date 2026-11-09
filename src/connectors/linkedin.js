// Connecteur LinkedIn : nombre d'abonnés d'une page entreprise.
// Nécessite un jeton avec l'accès « Community Management API » de LinkedIn.
export async function stats({ token, orgId }) {
  const urn = encodeURIComponent(`urn:li:organization:${orgId}`);
  const res = await fetch(`https://api.linkedin.com/rest/networkSizes/${urn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, {
    headers: {
      authorization: `Bearer ${token}`,
      "LinkedIn-Version": process.env.LINKEDIN_VERSION || "202509",
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`LinkedIn : ${data.message || res.status}`);
  return { abonnes: data.firstDegreeSize };
}
