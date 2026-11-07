import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';
import { db, one, run, transaction } from './db.js';
import { id } from './core.js';

if (one<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count > 0) {
  throw new Error('La base contient deja des comptes. Le jeu de demonstration ne peut etre ajoute que dans une base vide.');
}
const supplied = process.env.DEMO_PASSWORD;
if (supplied && (supplied.length < 10 || supplied.length > 128)) throw new Error('DEMO_PASSWORD doit contenir entre 10 et 128 caracteres.');
const password = supplied ?? randomBytes(18).toString('base64url');
const passwordHash = await hashPassword(password);
const users = [
  { id: id(), name: 'Camille Martin', email: 'camille@alpha.test', title: 'Product builder · React & idées ambitieuses', color: '#b99585', skills: ['React', 'TypeScript', 'Product design'], role: 'member' },
  { id: id(), name: 'Alex Laurent', email: 'alex@alpha.test', title: 'Testeur curieux · UX & accessibilité', color: '#91a895', skills: ['Tests UX', 'Accessibilité', 'Web'], role: 'member' },
  { id: id(), name: 'Sam Dubois', email: 'sam@alpha.test', title: 'Développeur indépendant · Open source', color: '#ad9bc0', skills: ['Python', 'IA', 'API'], role: 'member' },
  { id: id(), name: 'Noa Petit', email: 'noa@alpha.test', title: 'Designer · Des interfaces qui font du bien', color: '#c4a46f', skills: ['Figma', 'Design system', 'UX'], role: 'member' },
  { id: id(), name: 'Lou Moreau', email: 'lou@alpha.test', title: 'Mobile maker · Une idée à la fois', color: '#899fba', skills: ['Flutter', 'Mobile', 'Tests'], role: 'member' },
  { id: id(), name: 'Équipe Alpha', email: 'admin@alpha.test', title: 'Confiance & accompagnement', color: '#8e79b8', skills: ['Modération'], role: 'admin' },
];
const [camille, alex, sam, noa, lou, admin] = users;
const projectIds = [id(), id(), id(), id(), id(), id()];
const campaignIds = [id(), id(), id(), id()];
const groupIds = [id(), id(), id()];
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const past = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

transaction(() => {
  for (const user of users) run('INSERT INTO users (id,name,email,password_hash,title,bio,skills,avatar_color,role) VALUES (?,?,?,?,?,?,?,?,?)',
    user.id, user.name, user.email, passwordHash, user.title,
    'Profil fictif de démonstration. Ici pour construire, apprendre et partager avec le collectif.',
    JSON.stringify(user.skills), user.color, user.role);
  const orgId = id();
  run('INSERT INTO organizations (id,owner_id,name,description) VALUES (?,?,?,?)', orgId, camille.id, 'Studio Collectif', 'Un petit studio pour des projets utiles.');
  run("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,'owner')", orgId, camille.id);
  run("INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,'member')", orgId, noa.id);
  const projects = [
    { title: 'Flowboard', summary: 'Moins de chaos, plus de flow. Le workspace qui simplifie vos projets.', description: 'Flowboard réunit vos tâches, vos notes et votre équipe dans un espace simple et agréable. Nous cherchons des retours sur le parcours de création de projet et la lisibilité du tableau de bord.', category: 'Productivité', stage: 'beta', tags: ['React', 'TypeScript', 'SaaS'], color: '#a18cce', owner: camille.id },
    { title: 'DevPocket', summary: 'Vos snippets préférés. Toujours au bon endroit, au bon moment.', description: 'Une bibliothèque personnelle de snippets pour les développeurs. Classez vos fragments de code, retrouvez-les rapidement et partagez les plus utiles avec votre équipe.', category: 'Outils dev', stage: 'prototype', tags: ['Next.js', 'Open source'], color: '#d3a775', owner: sam.id },
    { title: 'Plantify', summary: 'Un compagnon de poche pour des plantes qui se portent bien.', description: 'Des conseils simples pour prendre soin de vos plantes. Le prototype explore les rappels, le suivi des arrosages et une expérience mobile accessible aux débutants.', category: 'Application mobile', stage: 'beta', tags: ['Flutter', 'Mobile'], color: '#7fa994', owner: lou.id },
    { title: 'Forma UI', summary: 'Des composants accessibles pour construire des interfaces plus humaines.', description: 'Un design system indépendant pour les équipes qui souhaitent livrer des interfaces cohérentes et accessibles.', category: 'Design', stage: 'launched', tags: ['Figma', 'Design system'], color: '#a190bc', owner: noa.id },
    { title: 'Echo Notes', summary: 'Transformez les discussions en actions, sans perdre les nuances.', description: 'Un outil expérimental de prise de notes structurées pour les réunions. Les données de démonstration sont fictives.', category: 'Intelligence artificielle', stage: 'idea', tags: ['Python', 'IA'], color: '#8ca6c6', owner: sam.id },
    { title: 'Projet confidentiel', summary: 'Un espace privé de démonstration.', description: 'Ce projet ne doit pas être visible dans les listes publiques, les profils publics ou les exports non autorisés.', category: 'Productivité', stage: 'prototype', tags: ['Privé'], color: '#98919f', owner: camille.id },
  ];
  projects.forEach((project, index) => run('INSERT INTO projects (id,owner_id,organization_id,title,summary,description,category,stage,visibility,tags,color,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    projectIds[index], project.owner, index === 0 ? orgId : null, project.title, project.summary, project.description, project.category, project.stage, index === 5 ? 'private' : 'public', JSON.stringify(project.tags), project.color, past(index)));
  const campaigns = [
    { project: 0, owner: camille.id, title: 'Un premier regard sur Flowboard', description: 'Créez un projet, ajoutez trois tâches et invitez un collaborateur fictif. Dites-nous ce qui vous paraît intuitif, ce qui vous ralentit et ce qui manque. Un rapport utile et honnête est attendu, sans obligation d’avis positif.', kind: 'usability', reward: 2500, slots: 5, devices: 'Web · ordinateur' },
    { project: 2, owner: lou.id, title: 'Plantify cherche ses premiers testeurs', description: 'Explorez le parcours de découverte et la création d’un rappel. Partagez vos observations avec des étapes reproductibles et vos suggestions.', kind: 'functional', reward: 1800, slots: 4, devices: 'Android · iOS' },
    { project: 1, owner: sam.id, title: 'Les snippets, mais en plus simple', description: 'Testez la recherche, la création et le classement d’un extrait de code. Nous cherchons des développeurs débutants comme expérimentés.', kind: 'usability', reward: 3500, slots: 3, devices: 'Web · ordinateur' },
    { project: 0, owner: camille.id, title: 'Parcours de création — session terminée', description: 'Campagne fictive terminée pour illustrer un rapport accepté, un versement et un avis vérifié.', kind: 'usability', reward: 2000, slots: 1, devices: 'Web' },
  ];
  campaigns.forEach((campaign, index) => {
    run('INSERT INTO campaigns (id,project_id,owner_id,title,description,kind,reward_cents,slots,requirements,target_devices,deadline,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      campaignIds[index], projectIds[campaign.project], campaign.owner, campaign.title, campaign.description, campaign.kind, campaign.reward, campaign.slots,
      'Un rapport détaillé en français avec des observations concrètes. Comptez environ 30 minutes.', campaign.devices, future(14 + index), index === 3 ? 'closed' : 'open', past(index));
    run("INSERT INTO transactions (id,user_id,campaign_id,kind,amount_cents) VALUES (?,?,?,'funding',?)", id(), campaign.owner, campaignIds[index], campaign.reward * campaign.slots);
  });
  const applicationId = id();
  const missionId = id();
  run("INSERT INTO applications (id,campaign_id,tester_id,motivation,status) VALUES (?,?,?,?,'accepted')", applicationId, campaignIds[3], alex.id, 'Je souhaite apporter un regard utilisateur et tester la navigation clavier.');
  run("INSERT INTO missions (id,campaign_id,tester_id,application_id,status) VALUES (?,?,?,?,'paid')", missionId, campaignIds[3], alex.id, applicationId);
  run('INSERT INTO test_reports (id,mission_id,summary,steps,expected,observed) VALUES (?,?,?,?,?,?)', id(), missionId, 'Le parcours est clair, avec une amélioration possible sur le focus clavier.', 'Ouvrir le formulaire puis naviguer avec Tab.', 'Un focus visible sur chaque champ.', 'Le focus du bouton secondaire manque de contraste.');
  run("INSERT INTO transactions (id,user_id,campaign_id,mission_id,kind,amount_cents) VALUES (?,?,?,?,'payout',2000)", id(), alex.id, campaignIds[3], missionId);
  run('INSERT INTO reviews (id,author_id,subject_id,mission_id,rating,body) VALUES (?,?,?,?,?,?)', id(), camille.id, alex.id, missionId, 5, 'Un rapport précis, des étapes faciles à reproduire et des suggestions très utiles. Merci pour ce regard attentif !');
  run('INSERT INTO reviews (id,author_id,subject_id,mission_id,rating,body) VALUES (?,?,?,?,?,?)', id(), alex.id, camille.id, missionId, 5, 'Des consignes claires et des échanges constructifs. Une collaboration agréable.');
  run('UPDATE reviews SET communication_rating=5,quality_rating=4 WHERE author_id=? AND mission_id=?', camille.id, missionId);
  const pendingId = id();
  run('INSERT INTO applications (id,campaign_id,tester_id,motivation) VALUES (?,?,?,?)', pendingId, campaignIds[0], alex.id, 'Je peux tester le parcours utilisateur et la navigation au clavier sur ordinateur.');
  const groups = [
    { name: 'Les Indie Builders', description: 'Construire en indépendant, mais jamais seul. Partageons nos avancées et nos questions.', category: 'Entreprendre', color: '#ae93c6', owner: camille.id },
    { name: 'Le Lab des Testeurs', description: 'Des retours utiles, des méthodes et beaucoup de curiosité. Tous les niveaux sont bienvenus.', category: 'Testing', color: '#8aada0', owner: alex.id },
    { name: 'Design & Café', description: 'Un espace pour parler UX, accessibilité et petits détails qui changent tout.', category: 'Design', color: '#c5a177', owner: noa.id },
  ];
  groups.forEach((group, index) => {
    run('INSERT INTO groups (id,owner_id,name,description,category,color) VALUES (?,?,?,?,?,?)', groupIds[index], group.owner, group.name, group.description, group.category, group.color);
    for (const user of users.slice(0, index === 0 ? 5 : 4)) run('INSERT INTO group_members (group_id,user_id) VALUES (?,?)', groupIds[index], user.id);
  });
  const postId = id();
  run('INSERT INTO posts (id,author_id,group_id,body) VALUES (?,?,?,?)', postId, camille.id, groupIds[0], 'Après quelques semaines à construire Flowboard, la première version est enfin prête à rencontrer ses utilisateurs. ✨\n\nJe cherche des regards neufs, pas forcément des experts. Parfois, le meilleur retour commence par « je ne comprends pas ce bouton ».');
  run('INSERT INTO posts (id,author_id,group_id,body,created_at) VALUES (?,?,?,?,?)', id(), noa.id, groupIds[2], 'Petit rappel du jour : tester son interface au clavier prend cinq minutes et révèle souvent des choses que la souris nous cache. Vous avez un petit rituel qualité avant de publier ?', past(1));
  for (const user of [alex, sam, noa]) run('INSERT INTO post_likes (post_id,user_id) VALUES (?,?)', postId, user.id);
  run('INSERT INTO comments (id,post_id,author_id,body) VALUES (?,?,?,?)', id(), postId, alex.id, 'Exactement ! Un regard extérieur peut faire toute la différence. Je viens de candidater.');
  run('INSERT INTO user_follows(follower_id,following_id) VALUES (?,?),(?,?),(?,?)', alex.id, camille.id, alex.id, sam.id, camille.id, noa.id);
  run('INSERT INTO project_follows(user_id,project_id) VALUES (?,?),(?,?)', alex.id, projectIds[0], sam.id, projectIds[0]);
  run('INSERT INTO posts(id,author_id,project_id,body) VALUES (?,?,?,?)', id(), camille.id, projectIds[0],
    'Nouveau chapitre pour Flowboard : nous préparons les retours des premiers testeurs. Suivez le projet pour retrouver ses prochaines avancées dans votre fil. ✨');
  run('INSERT INTO organization_invitations(id,organization_id,inviter_id,invitee_id,role,expires_at) VALUES (?,?,?,?,?,?)',
    id(), orgId, camille.id, alex.id, 'member', future(7));
  run('INSERT INTO notifications(id,user_id,kind,title,body,link) VALUES (?,?,?,?,?,?)', id(), alex.id, 'invitation', 'Une équipe vous invite',
    'Consultez les accès proposés avant de choisir de rejoindre l’équipe.', '/settings#invitations');
  for (const task of [
    { title: 'Préparer le guide des testeurs', description: 'Préciser le parcours à explorer et les critères d’un rapport utile.', assignee: camille.id, status: 'todo', priority: 'high' },
    { title: 'Améliorer les états de focus', description: 'Contrôler la navigation clavier des écrans principaux.', assignee: noa.id, status: 'in_progress', priority: 'normal' },
    { title: 'Définir le périmètre du prototype', description: 'Documenter ce qui est inclus dans la première campagne.', assignee: camille.id, status: 'done', priority: 'normal' },
  ]) {
    run('INSERT INTO project_tasks(id,project_id,creator_id,assignee_id,title,description,status,priority,due_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id(), projectIds[0], camille.id, task.assignee, task.title, task.description, task.status, task.priority, future(5));
  }
  const listings = [
    { title: 'Forma — Kit UI accessible', description: 'Une base claire pour concevoir vos prochains produits. Un kit de démonstration avec composants, styles et conseils d’utilisation.', kind: 'component', price: 4900, license: 'Licence non exclusive pour un projet commercial. Redistribution du kit non autorisée.', deliverables: 'Fichier de design, documentation et guide de prise en main.', seller: noa.id, project: projectIds[3] },
    { title: 'Session de revue UX', description: 'Un regard extérieur structuré sur les parcours clés de votre application. Périmètre à convenir avant la commande.', kind: 'service', price: 7500, license: 'Prestation non exclusive. Le rapport est remis au client pour son usage interne.', deliverables: 'Revue de trois écrans, synthèse des observations et recommandations priorisées.', seller: alex.id, project: null },
    { title: 'Concept — Le carnet des makers', description: 'Un dossier de concept pour une application de journal de construction. Il ne garantit ni exclusivité ni protection juridique de l’idée.', kind: 'concept', price: 2900, license: 'Droit non exclusif de consulter et adapter le dossier. Aucun transfert de marque ou de brevet.', deliverables: 'Dossier de concept, hypothèses produit et cinq wireframes exploratoires.', seller: sam.id, project: null },
  ];
  const listingIds = listings.map(() => id());
  listings.forEach((listing, index) => run('INSERT INTO listings (id,seller_id,project_id,title,description,kind,price_cents,license,deliverables) VALUES (?,?,?,?,?,?,?,?,?)',
    listingIds[index], listing.seller, listing.project, listing.title, listing.description, listing.kind, listing.price, listing.license, listing.deliverables));
  for (const [type, target] of [['project', projectIds[0]], ['campaign', campaignIds[0]], ['listing', listingIds[0]]]) {
    run('INSERT INTO bookmarks(user_id,target_type,target_id) VALUES (?,?,?)', alex.id, type, target);
  }
  const orderId = id();
  const delivery = 'Livraison fictive : synthèse des observations sur les trois écrans convenus et pistes d’amélioration.';
  run(`INSERT INTO orders(id,listing_id,buyer_id,seller_id,price_cents,status,delivery_text,version,revision_requested,created_at)
    VALUES (?,?,?,?,?,'paid',?,3,1,?)`, orderId, listingIds[1], camille.id, alex.id, listings[1].price, delivery, past(2));
  run("INSERT INTO transactions(id,user_id,order_id,kind,amount_cents,created_at) VALUES (?,?,?,'purchase',?,?)",
    id(), camille.id, orderId, listings[1].price, past(2));
  for (const event of [
    { actor: camille.id, kind: 'purchased', body: '', version: 1, date: past(2) },
    { actor: alex.id, kind: 'delivered', body: delivery, version: 2, date: past(1) },
    { actor: camille.id, kind: 'revision_requested', body: 'Merci de préciser les priorités et les étapes de reproduction pour chaque observation.', version: 3, date: past(0) },
  ]) {
    run('INSERT INTO order_events(id,order_id,actor_id,kind,body,order_version,created_at) VALUES (?,?,?,?,?,?,?)',
      id(), orderId, event.actor, event.kind, event.body, event.version, event.date);
  }
  run('INSERT INTO notifications(id,user_id,kind,title,body,link) VALUES (?,?,?,?,?,?)', id(), alex.id, 'order',
    'Une livraison démo attend vos corrections', 'Consultez la demande privée de votre acheteur.', `/marketplace?view=orders&order=${orderId}`);
  const conversationId = id();
  run('INSERT INTO conversations (id,subject,created_by) VALUES (?,?,?)', conversationId, 'Merci pour votre retour sur Flowboard', camille.id);
  for (const user of [camille, alex]) run('INSERT INTO conversation_members (conversation_id,user_id) VALUES (?,?)', conversationId, user.id);
  run('INSERT INTO messages (id,conversation_id,sender_id,body) VALUES (?,?,?,?)', id(), conversationId, camille.id, 'Bonjour Alex ! Merci pour votre rapport. Nous avons amélioré le focus clavier grâce à vos observations. À bientôt pour la prochaine version.');
  run('INSERT INTO notifications (id,user_id,kind,title,body,link) VALUES (?,?,?,?,?,?)', id(), alex.id, 'message', 'Camille vous a écrit', 'Un nouveau message vous attend dans votre espace.', `/messages?conversation=${conversationId}`);
  run('INSERT INTO notifications (id,user_id,kind,title,body,link) VALUES (?,?,?,?,?,?)', id(), camille.id, 'application', 'Une candidature pour Flowboard', 'Alex souhaite participer à votre campagne.', `/missions/${campaignIds[0]}`);
  run('INSERT INTO audit_events (id,actor_id,action,target_type,target_id,detail) VALUES (?,?,?,?,?,?)', id(), admin.id, 'demo.seed.created', 'platform', 'alpha', 'Données fictives, paiements simulés.');
});
console.log('Jeu de demonstration V3 cree : collectif, equipes, favoris et commande avec demande de correction.');
console.log('Comptes : camille@alpha.test (createur), alex@alpha.test (testeur), admin@alpha.test (moderation).');
if (!supplied) console.log(`Mot de passe genere pour ces comptes locaux : ${password}`);
else console.log('Mot de passe : valeur DEMO_PASSWORD fournie au lancement.');
db.close();
